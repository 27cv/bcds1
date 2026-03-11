// routes/blockchain.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { ethers } = require('ethers');
const BlockModel = require('../models/Block');

// Load Server Wallet Config
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:7545";
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY;

const calculateHash = (index, prevHash, timestamp, fileHash) => {
    return crypto.createHash('sha256')
        .update(index + prevHash + timestamp + JSON.stringify(fileHash))
        .digest('hex');
};

const logToBlockchain = async (fileId) => {
    // 1. Genesis Block Check
    const chainCount = await BlockModel.countDocuments();
    if (chainCount === 0) {
        const genTime = new Date().toISOString();
        const genHash = calculateHash(0, "0", genTime, "GENESIS");
        await new BlockModel({ index: 0, timestamp: genTime, fileId: "0", fileHash: "GENESIS", prevHash: "0", hash: genHash, ethTxHash: "0x0" }).save();
    }

    // 2. Prevent Duplicates
    if (await BlockModel.findOne({ fileId })) throw new Error("File ID already exists");

    // 3. Create Local Block
    const latestBlock = await BlockModel.findOne().sort({ index: -1 });
    const newIndex = latestBlock.index + 1;
    const timestamp = new Date().toISOString();
    const fileHash = crypto.createHash('sha256').update(fileId.toString()).digest('hex');
    const newHash = calculateHash(newIndex, latestBlock.hash, timestamp, fileHash);

    let ethTxHash = "Failed - No Server Key";

    // 4. ETHEREUM ANCHORING: Burn the hash into the blockchain
    if (SERVER_PRIVATE_KEY) {
        try {
            const provider = new ethers.JsonRpcProvider(RPC_URL);
            const wallet = new ethers.Wallet(SERVER_PRIVATE_KEY, provider);
            
            // Send a transaction to ourselves, embedding the block hash in the 'data' payload
            const tx = await wallet.sendTransaction({
                to: wallet.address,
                data: "0x" + newHash 
            });
            
            ethTxHash = tx.hash;
            console.log(`✅ Anchored to Ethereum! TxID: ${ethTxHash}`);
        } catch (error) {
            console.error("⚠️ Ethereum Anchoring Failed (Is Ganache running?):", error.message);
            ethTxHash = "Failed - Network Error";
        }
    }

    // 5. Save combined record to MongoDB
    const newBlock = new BlockModel({
        index: newIndex, timestamp, fileId: fileId.toString(), fileHash, prevHash: latestBlock.hash, hash: newHash, ethTxHash
    });

    await newBlock.save();
    return newBlock;
};

router.get('/chain', async (req, res) => {
    try {
        const chain = await BlockModel.find().sort({ index: 1 });
        res.json(chain);
    } catch (err) { res.status(500).send("Server Error"); }
});

// @route   POST /api/blockchain/log
router.post('/log', async (req, res) => {
    try {
        const block = await logToBlockchain(req.body.fileId);
        res.json({ message: "File successfully logged to Blockchain Ledger", block, status: "IMMUTABLE" });
    } catch (err) {
        res.status(400).json({ message: err.message, status: "REJECTED" });
    }
});

// @route   GET /api/blockchain/chain
// @desc    Retrieve the entire ledger for auditing
router.get('/chain', async (req, res) => {
    try {
        const chain = await BlockModel.find().sort({ index: 1 });
        res.json(chain);
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

module.exports = router;
module.exports.logToBlockchain = logToBlockchain; // Export for internal server use