# 🚀 BCDS: Blockchain Cloud Database System

A secure, hybrid cloud storage solution that combines **AES-256 Encryption**, **AWS S3 Storage**, and a **Blockchain Ledger** to ensure data integrity, privacy, and auditability.

![Project Status](https://img.shields.io/badge/Status-Active-success)
![License](https://img.shields.io/badge/License-MIT-blue)

## 🌟 Key Features

* **🔐 Military-Grade Encryption:** Files are encrypted (AES-256) on the server *before* being sent to the cloud. Even the cloud provider (AWS) cannot read your data.
* **☁️ AWS S3 Integration:** Scalable, durable object storage managed via the AWS SDK.
* **⛓️ Immutable Audit Log:** Every file upload is hashed (SHA-256) and recorded in a local Blockchain ledger. This proves data has not been tampered with.
* **📂 Secure Sharing:** Generate unique, time-limited links to share files securely with external users.
* **👁️ Secure Preview:** Decrypt and view images directly in the browser using Blob URLs, without saving sensitive files to the local disk.
* **💎 Subscription Management:** Dynamic storage quotas (Basic: 50MB, Premium: 50GB, Enterprise: 500GB) with real-time usage tracking.

---

## 🛠️ Tech Stack

* **Runtime:** Node.js
* **Framework:** Express.js
* **Database:** MongoDB Atlas (User Data & Metadata)
* **Storage:** AWS S3 (Encrypted Blobs)
* **Security:** JSON Web Token (JWT), BCrypt, Crypto (Node.js)
* **Frontend:** HTML5, CSS3, Vanilla JavaScript (Fetch API)

---

## ⚙️ Installation & Setup

### 1. Prerequisites
Ensure you have the following installed/configured:
* [Node.js](https://nodejs.org/) (v14 or higher)
* [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) Connection String
* [AWS S3 Bucket](https://aws.amazon.com/s3/) (Access Key & Secret Key)

### 2. Clone the Repository
```bash
git clone [https://github.com/your-username/bcds-secure-storage.git](https://github.com/your-username/bcds-secure-storage.git)
cd bcds

#### Additional notes for you ####

### 3. Install Dependencies
npm install express mongoose dotenv aws-sdk bcryptjs jsonwebtoken multer cors

### 4. Configure Environment Variables

Create a file named .env in the root directory and add your credentials:
# Server Configuration
PORT=5000

# Database Connection
MONGO_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/bcds?retryWrites=true&w=majority

# Security Secret
JWT_SECRET=mysecrettoken

# AWS S3 Credentials
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1
AWS_BUCKET_NAME=your_bucket_name

### 5. Run the Server (in the VSC terminal)
node server.js