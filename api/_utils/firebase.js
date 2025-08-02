// =======================================================================
// File #1: /api/_utils/firebase.js
// Tujuan: Inisialisasi Firebase Admin di satu tempat agar rapi.
// =======================================================================

const admin = require('firebase-admin');

// Ambil kunci rahasia dari Environment Variable di Vercel
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// Inisialisasi Firebase Admin SDK (hanya jika belum ada)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
module.exports = { db, admin };


// =======================================================================
// File #2: /api/createInvoice.js
// Tujuan: Membuat invoice pembayaran di Xendit secara aman.
// Endpoint: www.jalankerja.id/api/createInvoice
// =======================================================================

const axios = require('axios');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method Not Allowed' });
  }

  const { amount, payerEmail, description, userId, promoCode } = req.body;
  const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;

  // Buat ID eksternal yang unik untuk setiap transaksi
  const externalId = `JALANKERJA-${userId}-${Date.now()}`;

  try {
    const response = await axios.post(
      'https://api.xendit.co/v2/invoices',
      {
        external_id: externalId,
        amount: amount,
        payer_email: payerEmail,
        description: description,
        // Simpan metadata tambahan untuk webhook nanti
        metadata: {
            userId: userId,
            promoCode: promoCode || null
        }
      },
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(XENDIT_SECRET_KEY + ':').toString('base64')}`
        }
      }
    );

    res.status(200).json({ invoice_url: response.data.invoice_url });

  } catch (error) {
    console.error("Error creating Xendit invoice:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Gagal membuat invoice pembayaran.' });
  }
};


// =======================================================================
// File #3: /api/xenditCallback.js
// Tujuan: Menerima notifikasi (webhook) dari Xendit setelah pembayaran berhasil.
// Endpoint: www.jalankerja.id/api/xenditCallback
// =======================================================================

const { db, admin } = require('./_utils/firebase');

module.exports = async (req, res) => {
    const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN;
    const incomingToken = req.headers['x-callback-token'];

    // 1. Verifikasi Webhook Token dari Xendit (Keamanan)
    if (incomingToken !== XENDIT_WEBHOOK_TOKEN) {
        return res.status(403).send('Forbidden: Invalid token');
    }

    const data = req.body;

    // 2. Proses hanya jika status pembayaran adalah "PAID"
    if (data.status === 'PAID') {
        try {
            const { userId, promoCode } = data.metadata;

            if (!userId) {
                throw new Error(`User ID tidak ditemukan di metadata invoice: ${data.id}`);
            }

            const userRef = db.collection('users').doc(userId);
            const saleRef = db.collection('sales').doc();
            
            // 3. Jalankan semua update database dalam satu transaksi
            await db.runTransaction(async (transaction) => {
                // a. Aktivasi akun pengguna
                transaction.update(userRef, {
                    hasPaidAccess: true,
                    testAttemptsRemaining: admin.firestore.FieldValue.increment(1)
                });

                let commission = 0;
                let bonusPoolContribution = 0;
                let affiliateId = null;

                // b. Cari affiliate jika kode promo digunakan
                if (promoCode) {
                    const affiliateQuery = await db.collection('users').where('affiliateCode', '==', promoCode.toUpperCase()).limit(1).get();
                    
                    if (!affiliateQuery.empty) {
                        const affiliateDoc = affiliateQuery.docs[0];
                        affiliateId = affiliateDoc.id;
                        commission = 60000; // Rp 60.000
                        bonusPoolContribution = 40000; // Rp 40.000

                        // c. Update statistik affiliate
                        transaction.update(affiliateDoc.ref, {
                            monthlySales: admin.firestore.FieldValue.increment(1),
                            monthlyCommission: admin.firestore.FieldValue.increment(commission)
                        });
                    }
                }
                
                // d. Catat penjualan baru
                transaction.set(saleRef, {
                    userId: userId,
                    invoiceId: data.id,
                    amount: data.paid_amount,
                    saleDate: admin.firestore.FieldValue.serverTimestamp(),
                    affiliateId: affiliateId,
                    commission: commission,
                    bonusPoolContribution: bonusPoolContribution,
                    promoCodeUsed: promoCode
                });
            });

            console.log(`Aktivasi & pencatatan komisi berhasil untuk user: ${userId}`);

        } catch (error) {
            console.error('Error processing webhook:', error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // Kirim respons sukses ke Xendit
    res.status(200).send('OK');
};
