const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Activity = require('../models/Activity');

// @route   GET /api/activity
router.get('/', auth, async (req, res) => {
    try {
        // THE FIX: Filter by the ID inside the JWT token
        const activities = await Activity.find({ userId: req.user.id })
            .sort({ date: -1 })
            .limit(10);
            
        res.json(activities);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

module.exports = router;