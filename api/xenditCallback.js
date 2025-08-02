// =======================================================================
// File: /api/xenditCallback.js
// Tujuan: Menerima notifikasi (webhook) dari Xendit setelah pembayaran berhasil.
// Endpoint: www.jalankerja.id/api/xenditCallback
// =======================================================================

const { db, admin } = require('./_utils/firebase');

module.exports = async (req, res) => {
    const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN;
    const incomingToken = req.headers['x-callback-token'];

    // 1. Verifikasi Webhook Token dari Xendit (Langkah Keamanan)
    if (incomingToken !== XENDIT_WEBHOOK_TOKEN) {
        console.warn('Invalid webhook token received.');
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
            
            // 3. Jalankan semua update database dalam satu transaksi atomik
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

    // Kirim respons sukses ke Xendit agar tidak mengirim notifikasi berulang
    res.status(200).send('OK');
};
