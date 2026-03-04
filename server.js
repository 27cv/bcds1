const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- 1. STRIPE WEBHOOK (MUST BE BEFORE express.json()) ---
// server.js

app.post('/api/subscription/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Process successful payments
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
        const session = event.data.object;
        const User = require('./models/User');
        const Activity = require('./models/Activity'); 
        
        // Find the user by Stripe Customer ID or the client_reference_id we sent during checkout
        const user = await User.findOne({ 
            $or: [{ stripeCustomerId: session.customer }, { _id: session.client_reference_id }] 
        });
        
        if (user) {
            // Update Plan and Storage Limits
            if (event.type === 'checkout.session.completed') {
                const purchasedPlan = session.metadata.planName; // Captured from the checkout session
                user.stripeCustomerId = session.customer;
                
                if (purchasedPlan === 'Premium') {
                    user.package = 'Premium';
                    user.storageLimit = 100 * 1024 * 1024 * 1024; // 100GB in bytes
                } else if (purchasedPlan === 'Enterprise') {
                    user.package = 'Enterprise';
                    user.storageLimit = 500 * 1024 * 1024 * 1024; // 500GB in bytes
                }

                await new Activity({
            userId: user._id,
            type: 'PAYMENT_SUCCESS', // Use a specific type
            details: `Successful Payment: Upgraded to ${user.package}`
        }).save();
            }

            // Update Expiry Date
            if (event.type === 'invoice.paid' && session.lines) {
                user.subscriptionEnd = new Date(session.lines.data[0].period.end * 1000);
            }
            
            await user.save();
        }
    }
    res.json({received: true});
});

// --- 2. MIDDLEWARE ---
app.use(express.json()); 
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], 
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token']
}));

// --- 3. ROUTES (PATH CORRECTIONS) ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/storage', require('./routes/storage'));
app.use('/api/blockchain', require('./routes/blockchain'));
app.use('/api/subscription', require('./routes/subscription'));

// --- 4. DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => {
    console.error("❌ MongoDB Connection Error:", err.message);
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));