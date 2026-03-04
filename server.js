const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- 1. STRIPE WEBHOOK (MUST BE BEFORE express.json()) ---
app.post('/api/subscription/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'invoice.paid' || event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const User = require('./models/User');
        const Activity = require('./models/Activity'); 
        
        const user = await User.findOne({ 
            $or: [{ stripeCustomerId: session.customer }, { _id: session.client_reference_id }] 
        });
        
        if (user) {
            if (event.type === 'checkout.session.completed') {
    user.stripeCustomerId = session.customer;
    
    // Get the plan name we just added to metadata
    const newPlan = session.metadata?.planName; 
    if (newPlan) {
        user.package = newPlan;
        
        // Update storage limits based on the plan
        if (newPlan === 'Premium') {
            user.storageLimit = 2 * 1024 * 1024 * 1024; // 2GB
        } else if (newPlan === 'Enterprise') {
            user.storageLimit = 10 * 1024 * 1024 * 1024; // 10GB
        }
    }

    await new Activity({
        userId: user._id,
        type: 'PLAN_UPGRADED',
        details: `Upgraded to ${user.package}`
    }).save();
}

            if (event.type === 'invoice.paid') {
                user.subscriptionEnd = new Date(session.lines.data[0].period.end * 1000);
                await new Activity({
                    userId: user._id,
                    type: 'PAYMENT_SUCCESS',
                    details: `Payment successful for ${user.package}`
                }).save();
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