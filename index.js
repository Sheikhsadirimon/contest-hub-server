const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");

const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(cors());

const serviceAccount = require("./contest-hub-firebase-adminsdk.json"); // Download from Firebase Console

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@clusterpro.d9ffs3x.mongodb.net/?appName=ClusterPro`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("contest_hub_db");
    const usersCollection = db.collection("users");
    const contestsCollection = db.collection("contests");

    // ==================== FIREBASE TOKEN VERIFICATION ====================
    const verifyFirebaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = {
          uid: decoded.uid,
          email: decoded.email,
          role: null, // We'll fetch from DB
        };
        next();
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).send({ message: "Invalid or expired token" });
      }
    };

    // Role verification (after fetching from DB)
    const verifyRole = (requiredRole) => async (req, res, next) => {
      try {
        const userDoc = await usersCollection.findOne({ uid: req.user.uid });
        if (!userDoc || userDoc.role !== requiredRole) {
          return res
            .status(403)
            .send({ message: "Forbidden: Insufficient role" });
        }
        req.user.role = userDoc.role; // Attach role
        next();
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    };

    // ==================== USER ROUTES ====================

    // POST /users - Create or update user on signup/login
    app.post("/users", async (req, res) => {
      const { uid, email, displayName, photoURL } = req.body;

      if (!uid || !email) {
        return res.status(400).send({ error: "uid and email required" });
      }

      const userDoc = {
        uid,
        email,
        displayName: displayName || "",
        photoURL: photoURL || "",
        role: "user",
        createdAt: new Date(),
      };

      const result = await usersCollection.updateOne(
        { uid },
        { $setOnInsert: userDoc },
        { upsert: true }
      );

      res.send({ success: true, role: "user" });
    });

    // GET /user/:uid - Get user data (role, etc.)
    app.get("/user/:uid", async (req, res) => {
      const uid = req.params.uid;
      const user = await usersCollection.findOne({ uid });
      if (!user) return res.status(404).send({ error: "User not found" });
      res.send(user);
    });

    // Admin: Get all users
    app.get(
      "/admin/users",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const users = await usersCollection.find({}).toArray();
        res.send(users);
      }
    );

    // Admin: Change user role
    app.patch(
      "/admin/users/:id/role",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const { role } = req.body;
        if (!["user", "creator", "admin"].includes(role)) {
          return res.status(400).send({ error: "Invalid role" });
        }
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role } }
        );
        if (result.matchedCount === 0)
          return res.status(404).send({ error: "User not found" });
        res.send({ success: true });
      }
    );

    // contests api
    app.get("/contests", async (req, res) => {
      const contests = await contestsCollection
        .find({})
        .sort({ participants: -1 }) // Highest participants first
        .limit(10) // Optional: limit if you want
        .toArray();
      res.send(contests);
    });

    app.post("/contests", async (req, res) => {
      const contest = req.body;
      const result = await contestsCollection.insertOne(contest);
      res.send({ ...contest, _id: result.insertedId });
    });

    app.get("/contest/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestsCollection.findOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("A place for your contests");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
