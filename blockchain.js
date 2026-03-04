const express = require('express');
const router = express.Router();
const crypto = require('crypto');

class Block {
    constructor(index, timestamp, fileId, fileHash, prevHash = "") {
        this.index = index;
        this.timestamp = timestamp;
        this.fileId = fileId;
        this.fileHash = fileHash;
        this.prevHash = prevHash;
        this.hash = this.calculateHash();
    }
    calculateHash() {
        return crypto.createHash('sha256')
            .update(this.index + this.prevHash + this.timestamp + JSON.stringify(this.fileHash))
            .digest('hex');
    }
}

class Blockchain {
    constructor() {
        this.chain = [this.createGenesisBlock()];
    }
    createGenesisBlock() {
        return new Block(0, new Date().toISOString(), "0", "GENESIS_BLOCK", "0");
    }
    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }
    addBlock(newBlock) {
        newBlock.prevHash = this.getLatestBlock().hash;
        newBlock.hash = newBlock.calculateHash();
        this.chain.push(newBlock);
    }
}

const myChain = new Blockchain();

// @route   POST /api/blockchain/log
router.post('/log', (req, res) => {
    const { fileId } = req.body;
    
    // --- PREVENT DUPLICATE MINING ---
    const blockExists = myChain.chain.some(block => block.fileId === fileId);
    if (blockExists) {
        return res.status(400).json({ 
            message: "File ID already exists in the Blockchain Ledger",
            status: "DUPLICATE_REJECTED"
        });
    }

    // --- MINE BLOCK ---
    const fileHash = crypto.createHash('sha256').update(fileId).digest('hex');
    const newBlock = new Block(
        myChain.chain.length,
        new Date().toISOString(),
        fileId,
        fileHash
    );

    myChain.addBlock(newBlock);

    res.json({
        message: "File successfully logged to Blockchain Ledger",
        blockIndex: newBlock.index,
        fileHash: newBlock.fileHash,
        status: "IMMUTABLE"
    });
});

// @route   GET /api/blockchain/chain
router.get('/chain', (req, res) => {
    res.json(myChain.chain);
});

module.exports = router;