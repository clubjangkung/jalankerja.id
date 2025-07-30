const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// Cloud Function to process manual activation requests from the admin dashboard.
exports.processActivationRequest = functions.https.onCall(async (data, context) => {
    // 1. Check if the user calling the function is an admin.
    if (!context.auth || context.auth.token.role !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Hanya admin yang bisa menjalankan fungsi ini.');
    }

    const { requestId, userId, affiliateCode, discountCode } = data;

    if (!requestId || !userId) {
        throw new functions.https.HttpsError('invalid-argument', 'Request ID dan User ID wajib diisi.');
    }

    try {
        const userRef = db.collection('users').doc(userId);
        const requestRef = db.collection('activationRequests').doc(requestId);

        // Start a transaction to ensure all database operations succeed or fail together.
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('User tidak ditemukan.');
            }

            // 2. Update user's access rights.
            transaction.update(userRef, {
                hasPaidAccess: true,
                testAttemptsRemaining: 1,
            });

            // 3. Mark the activation request as completed.
            transaction.update(requestRef, {
                status: 'completed',
                processedBy: context.auth.uid,
                processedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 4. If an affiliate code was used, process the commission.
            if (affiliateCode) {
                const affiliateQuery = await db.collection('users').where('affiliateCode', '==', affiliateCode.toUpperCase()).limit(1).get();
                
                if (!affiliateQuery.empty) {
                    const affiliateDoc = affiliateQuery.docs[0];
                    const affiliateRef = affiliateDoc.ref;
                    const affiliateData = affiliateDoc.data();

                    const newSalesCount = (affiliateData.monthlySales || 0) + 1;
                    const newCommission = (affiliateData.monthlyCommission || 0) + 60000; // Rp 60.000
                    const newBonusPoolContribution = (affiliateData.monthlyBonusPoolContribution || 0) + 40000; // Rp 40.000

                    transaction.update(affiliateRef, {
                        monthlySales: newSalesCount,
                        monthlyCommission: newCommission,
                        monthlyBonusPoolContribution: newBonusPoolContribution
                    });
                }
            }
            
            // Note: B2B discount code usage is already handled on the client side
            // and recorded. This function focuses on activation and commission.
        });

        return { success: true, message: `Aktivasi untuk user ID ${userId} berhasil diproses.` };

    } catch (error) {
        console.error("Error processing activation:", error);
        throw new functions.https.HttpsError('unknown', 'Terjadi kesalahan saat memproses aktivasi.', error.message);
    }
});
