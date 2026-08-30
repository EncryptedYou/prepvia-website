module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId) {
            return res.status(500).json({
                error: "RAZORPAY_KEY_ID is missing"
            });
        }

        if (!keySecret) {
            return res.status(500).json({
                error: "RAZORPAY_KEY_SECRET is missing"
            });
        }

        const auth = Buffer.from(
            keyId + ":" + keySecret
        ).toString("base64");

        const response = await fetch(
            "https://api.razorpay.com/v1/orders",
            {
                method: "POST",
                headers: {
                    "Authorization": "Basic " + auth,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    amount: 100,
                    currency: "INR",
                    receipt: "prepvia_" + Date.now(),
                    notes: {
                        product: "JEE_NEET_SUCCESS_PACKAGE"
                    }
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Razorpay error:", data);

            return res.status(response.status).json({
                error: data.error?.description || "Razorpay order creation failed"
            });
        }

        return res.status(200).json({
            key_id: keyId,
            order_id: data.id,
            amount: data.amount,
            currency: data.currency
        });

    } catch (error) {
        console.error("Create order error:", error);

        return res.status(500).json({
            error: "Unable to create payment order.",
            details: error.message
        });
    }
};
