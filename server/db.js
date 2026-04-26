const { MongoClient } = require('mongodb');

const DB_NAME = 'videochat';
const ROOMS_COLLECTION = 'rooms';

let client = null;
let db = null;
let roomsColl = null;

/**
 * Connect to MongoDB and return collection references.
 * Reuses existing connection if already connected.
 */
async function connectDB() {
    if (db && roomsColl) {
        return { db, roomsColl };
    }

    const uri = process.env.uri || process.env.URI || process.env.MONGO_URL;
    if (!uri) {
        throw new Error('MongoDB URI not found. Set "uri" or "MONGO_URL" in environment variables.');
    }

    client = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    });

    await client.connect();
    console.log('[DB] Connected to MongoDB');

    db = client.db(DB_NAME);
    roomsColl = db.collection(ROOMS_COLLECTION);

    // Ensure index for fast lookups
    await roomsColl.createIndex({ roomCode: 1 }, { unique: true }).catch(() => { });
    await roomsColl.createIndex({ 'users.socketId': 1 }).catch(() => { });

    return { db, roomsColl };
}

/**
 * Gracefully close the MongoDB connection.
 */
async function closeDB() {
    if (client) {
        await client.close();
        client = null;
        db = null;
        roomsColl = null;
        console.log('[DB] MongoDB connection closed');
    }
}

module.exports = { connectDB, closeDB };
