const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },

    // Allows MongoDB to save the Stripe connection
    stripeCustomerId: { type: String, default: null },

    // Subscription & Storage
    package: { type: String, default: 'Basic' },
    storageLimit: { type: Number, default: 52428800 }, // EXACTLY 50MB in bytes
    storageUsed: { type: Number, default: 0 },

    // Dates
    subscriptionStart: { type: Date, default: Date.now },
    subscriptionEnd: { type: Date, default: null }, // Null means forever (Basic)

    // Team Sharing Features
    sharedUsers: { type: Array, default: [] }, // Array of emails they shared storage with
    maxSharedLimit: { type: Number, default: 0 }, // 0 for Basic, 10 Premium, 100 Ent.

    workspacesJoined: [{ type: mongoose.Schema.Types.ObjectId, ref: 'user' }],

    date: { type: Date, default: Date.now },

    // Workspace Creation Tracking
    workspacesCreated: [{
        name: { type: String, required: true },
        allocatedBytes: { type: Number, required: true },
        createdAt: { type: Date, default: Date.now }
    }]
});

module.exports = mongoose.model('user', UserSchema);