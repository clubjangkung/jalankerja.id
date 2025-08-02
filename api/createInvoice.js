// =======================================================================
// File: /api/createInvoice.js
// Tujuan: Membuat invoice pembayaran di Xendit secara aman.
// Endpoint: www.jalankerja.id/api/createInvoice
// =======================================================================

const axios = require('axios');

module.exports = async (req, res) => {
  // Hanya izinkan metode POST
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
          // Otentikasi ke Xendit menggunakan Secret Key
          'Authorization': `Basic ${Buffer.from(XENDIT_SECRET_KEY + ':').toString('base64')}`
        }
      }
    );

    // Kirim kembali URL invoice ke aplikasi frontend
    res.status(200).json({ invoice_url: response.data.invoice_url });

  } catch (error) {
    console.error("Error creating Xendit invoice:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Gagal membuat invoice pembayaran.' });
  }
};
