const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

const serviceAccount = require("./contest-hub-firebase-adminsdk.json"); // Download from Firebase Console

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (error) {
    return res.status(401).send({ message: "Invalid token" });
  }
};

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

    // ==================== ADMIN ROUTES ====================

    // GET /admin/users - All users
    app.get(
      "/admin/users",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        try {
          const users = await usersCollection
            .find({})
            .project({ uid: 1, email: 1, displayName: 1, photoURL: 1, role: 1 })
            .toArray();
          res.send(users);
        } catch (error) {
          console.error("Error fetching users:", error);
          res.status(500).send({ error: "Failed to fetch users" });
        }
      }
    );

    // PATCH /admin/users/:id/role - Change role
    app.patch(
      "/admin/users/:id/role",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;

        if (!["user", "creator", "admin"].includes(role)) {
          return res.status(400).send({ error: "Invalid role" });
        }

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ error: "User not found" });
          }

          console.log("Role updated:", { userId: id, newRole: role });
          res.send({ success: true });
        } catch (error) {
          console.error("Role update failed:", error);
          res.status(500).send({ error: "Failed to update role" });
        }
      }
    );

    // GET /admin/contests - All contests (for admin)
    app.get(
      "/admin/contests",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        try {
          const contests = await contestsCollection.find({}).toArray();
          res.send(contests);
        } catch (error) {
          res.status(500).send({ error: "Failed to fetch contests" });
        }
      }
    );

    // PATCH /admin/contests/:id - Approve/Reject/Delete
    app.patch(
      "/admin/contests/:id",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const { id } = req.params;
        const { action } = req.body;

        if (!["approve", "reject", "delete"].includes(action)) {
          return res.status(400).send({ error: "Invalid action" });
        }

        try {
          if (action === "delete") {
            const deleteResult = await contestsCollection.deleteOne({
              _id: new ObjectId(id),
            });
            if (deleteResult.deletedCount === 0) {
              return res.status(404).send({ error: "Contest not found" });
            }
            return res.send({ success: true });
          }

          const update =
            action === "approve"
              ? { status: "approved" }
              : { status: "rejected" };
          const updateResult = await contestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: update }
          );

          if (updateResult.matchedCount === 0) {
            return res.status(404).send({ error: "Contest not found" });
          }

          res.send({ success: true });
        } catch (error) {
          console.error("Contest action failed:", error);
          res.status(500).send({ error: "Failed to process contest" });
        }
      }
    );

    // contests api-
    app.get("/contests", async (req, res) => {
      const contests = await contestsCollection
        .find({})
        .sort({ participants: -1 }) // Highest participants first
        .limit(10) // Optional: limit if you want
        .toArray();
      res.send(contests);
    });

    // POST /contests - Creator adds contest (pending)
    app.post("/contests", verifyFirebaseToken, verifyRole("creator"), async (req, res) => {
      const contestData = {
        ...req.body,
        creatorUid: req.user.uid,
        creatorEmail: req.user.email,
        status: "pending",
        participants: 0,
        createdAt: new Date(),
      };

      try {
        const result = await contestsCollection.insertOne(contestData);
        res.send({ ...contestData, _id: result.insertedId });
      } catch (error) {
        console.error("Contest creation failed:", error);
        res.status(500).send({ error: "Failed to create contest" });
      }
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
  res.send("Contest-Hub is running and gunning");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
