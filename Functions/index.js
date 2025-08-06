// File: functions/index.js
// Tujuan: Menjalankan logika backend untuk model B2B semi-otomatis di Firebase Spark Plan.

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

/**
 * Fungsi ini dipanggil oleh admin dari dashboard untuk memproses
 * permintaan aktivasi setelah pembayaran manual dari sekolah diverifikasi.
 *
 * @param {object} data - Data yang dikirim dari client.
 * @param {string} data.requestId - ID dari dokumen di koleksi 'activationRequests'.
 * @param {object} context - Konteks otentikasi dari fungsi yang dipanggil.
 *
 * @returns {Promise<{success: boolean, message: string}>} - Hasil dari proses aktivasi.
 */
exports.processActivationRequest = functions.https.onCall(async (data, context) => {
    // Langkah 1: Verifikasi bahwa yang memanggil adalah admin. Keamanan utama.
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Anda harus login untuk melakukan aksi ini.');
    }

    const adminUid = context.auth.uid;
    const adminDocRef = db.collection('users').doc(adminUid);
    
    try {
        const adminDoc = await adminDocRef.get();
        if (!adminDoc.exists || adminDoc.data().role !== 'admin') {
            throw new functions.https.HttpsError('permission-denied', 'Hanya admin yang bisa melakukan aksi ini.');
        }

        // Langkah 2: Dapatkan data dari permintaan aktivasi.
        const { requestId } = data;
        if (!requestId) {
            throw new functions.https.HttpsError('invalid-argument', 'Request ID tidak boleh kosong.');
        }

        const requestRef = db.collection('activationRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data().status === 'completed') {
            throw new functions.https.HttpsError('not-found', 'Permintaan tidak ditemukan atau sudah diproses.');
        }

        const requestData = requestDoc.data();
        const { userId, affiliateCode, schoolCode } = requestData; // schoolCode bisa jadi null

        // Langkah 3: Definisikan parameter bisnis
        const commissionFee = 60000; // Fee untuk affiliate atau sekolah
        const bonusPoolContribution = 40000;

        // Langkah 4: Jalankan semua update database dalam satu transaksi atomik.
        await db.runTransaction(async (transaction) => {
            // A. Aktivasi akun pengguna yang membayar.
            const userRef = db.collection('users').doc(userId);
            transaction.update(userRef, {
                hasPaidAccess: true,
                testAttemptsRemaining: admin.firestore.FieldValue.increment(1)
            });

            // B. Proses komisi untuk affiliate ATAU sekolah.
            let partnerId = null;
            let partnerType = null;
            
            if (affiliateCode) {
                const affiliateQuery = db.collection('users').where('affiliateCode', '==', affiliateCode.toUpperCase()).limit(1);
                const affiliateSnapshot = await transaction.get(affiliateQuery);
                if (!affiliateSnapshot.empty) {
                    const affiliateDoc = affiliateSnapshot.docs[0];
                    partnerId = affiliateDoc.id;
                    partnerType = 'affiliate';
                    
                    transaction.update(affiliateDoc.ref, {
                        monthlySales: admin.firestore.FieldValue.increment(1),
                        monthlyCommission: admin.firestore.FieldValue.increment(commissionFee)
                    });
                }
            } else if (schoolCode) {
                // Logika untuk mitra sekolah (B2B)
                // Anda bisa membuat koleksi 'schools' atau menggunakan 'discountCodes'
                // Untuk saat ini, kita asumsikan ada koleksi 'schools'
                const schoolRef = db.collection('schools').doc(schoolCode);
                partnerId = schoolCode;
                partnerType = 'school';
                
                transaction.update(schoolRef, {
                    totalStudentsReferred: admin.firestore.FieldValue.increment(1),
                    totalCommission: admin.firestore.FieldValue.increment(commissionFee)
                });
            }

            // C. Update status permintaan aktivasi menjadi 'completed'.
            transaction.update(requestRef, {
                status: 'completed',
                processedBy: adminUid,
                processedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // Langkah 5: Kirim respons sukses kembali ke dashboard admin.
        return { success: true, message: 'Aktivasi berhasil diproses!' };

    } catch (error) {
        console.error("Error processing activation request:", error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'Terjadi kesalahan di server saat memproses permintaan.');
    }
});
