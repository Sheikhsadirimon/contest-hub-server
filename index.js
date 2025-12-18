const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (error) {
    console.error("Invalid Firebase token:", error.message);
    return res.status(401).send({ message: "Invalid or expired token" });
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

let contestsCollection,
  usersCollection,
  submissionsCollection,
  paymentsCollection;

async function run() {
  try {
    // await client.connect();
    const db = client.db("contest_hub_db");
    usersCollection = db.collection("users");
    contestsCollection = db.collection("contests");
    submissionsCollection = db.collection("submissions");
    paymentsCollection = db.collection("payments");

    const verifyRole = (requiredRole) => async (req, res, next) => {
      try {
        const userDoc = await usersCollection.findOne({ uid: req.user.uid });
        if (!userDoc || userDoc.role !== requiredRole) {
          return res
            .status(403)
            .send({ message: "Forbidden: Insufficient role" });
        }
        req.user.role = userDoc.role;
        next();
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    };

    // ==================== USER ROUTES ====================/////////// /
    app.post("/users", async (req, res) => {
      const { uid, email, displayName, photoURL } = req.body;
      if (!uid || !email)
        return res.status(400).send({ error: "uid and email required" });

      const userDoc = {
        uid,
        email,
        displayName: displayName || "",
        photoURL: photoURL || "",
        role: "user",
        createdAt: new Date(),
      };

      await usersCollection.updateOne(
        { uid },
        { $setOnInsert: userDoc },
        { upsert: true }
      );
      res.send({ success: true });
    });

    app.get("/user/:uid", verifyFirebaseToken, async (req, res) => {
      if (req.params.uid !== req.user.uid) {
        return res.status(403).send({ error: "Forbidden" });
      }
      const user = await usersCollection.findOne({ uid: req.params.uid });
      if (!user) return res.status(404).send({ error: "User not found" });
      res.send(user);
    });

    app.patch("/user/:uid", verifyFirebaseToken, async (req, res) => {
      const { uid } = req.params;
      if (req.user.uid !== uid)
        return res.status(403).send({ error: "Forbidden" });

      const { displayName, photoURL, address } = req.body;

      try {
        await usersCollection.updateOne(
          { uid },
          { $set: { displayName, photoURL, address } }
        );
        res.send({ success: true });
      } catch (error) {
        res.status(500).send({ error: "Failed to update" });
      }
    });

    // ==================== ADMIN ROUTES ====================//////////////
    app.get(
      "/admin/users",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const users = await usersCollection
          .find({})
          .project({ uid: 1, email: 1, displayName: 1, photoURL: 1, role: 1 })
          .toArray();
        res.send(users);
      }
    );

    app.patch(
      "/admin/users/:id/role",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const { role } = req.body;
        if (!["user", "creator", "admin"].includes(role))
          return res.status(400).send({ error: "Invalid role" });

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role } }
        );
        if (result.matchedCount === 0)
          return res.status(404).send({ error: "User not found" });
        res.send({ success: true });
      }
    );

    app.get(
      "/admin/contests",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const contests = await contestsCollection.find({}).toArray();
        res.send(contests);
      }
    );

    app.patch(
      "/admin/contests/:id",
      verifyFirebaseToken,
      verifyRole("admin"),
      async (req, res) => {
        const { action } = req.body;
        if (!["approve", "reject", "delete"].includes(action))
          return res.status(400).send({ error: "Invalid action" });

        if (action === "delete") {
          await contestsCollection.deleteOne({
            _id: new ObjectId(req.params.id),
          });
          return res.send({ success: true });
        }

        const update =
          action === "approve"
            ? { status: "approved" }
            : { status: "rejected" };
        const result = await contestsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: update }
        );
        if (result.matchedCount === 0)
          return res.status(404).send({ error: "Contest not found" });
        res.send({ success: true });
      }
    );

    // ==================== CREATOR ROUTES ====================///////////
    app.get(
      "/creator/contests",
      verifyFirebaseToken,
      verifyRole("creator"),
      async (req, res) => {
        const contests = await contestsCollection
          .find({ creatorUid: req.user.uid })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(contests);
      }
    );

    app.post(
      "/contests",
      verifyFirebaseToken,
      verifyRole("creator"),
      async (req, res) => {
        const contestData = {
          ...req.body,
          creatorUid: req.user.uid,
          creatorEmail: req.user.email,
          status: "pending",
          participants: 0, // Number
          createdAt: new Date(),
        };

        const result = await contestsCollection.insertOne(contestData);
        res.send({ ...contestData, _id: result.insertedId });
      }
    );

    app.patch(
      "/contests/:id",
      verifyFirebaseToken,
      verifyRole("creator"),
      async (req, res) => {
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (
          !contest ||
          contest.creatorUid !== req.user.uid ||
          contest.status !== "pending"
        ) {
          return res.status(403).send({ error: "Forbidden" });
        }
        await contestsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: req.body }
        );
        res.send({ success: true });
      }
    );

    app.delete(
      "/contests/:id",
      verifyFirebaseToken,
      verifyRole("creator"),
      async (req, res) => {
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (
          !contest ||
          contest.creatorUid !== req.user.uid ||
          contest.status !== "pending"
        ) {
          return res.status(403).send({ error: "Forbidden" });
        }
        await contestsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send({ success: true });
      }
    );

    app.post(
      "/creator/submissions",
      verifyFirebaseToken,
      verifyRole("creator"),
      async (req, res) => {
        const { contestIds } = req.body;

        try {
          const subs = await submissionsCollection
            .find({ contestId: { $in: contestIds } })
            .toArray();
          res.send(subs);
        } catch (error) {
          res.status(500).send({ error: "Failed to fetch submissions" });
        }
      }
    );

    app.patch(
      "/contests/:id/winner",
      verifyFirebaseToken,
      verifyRole("creator"),
      async (req, res) => {
        const { id } = req.params;
        const { winner } = req.body;

        try {
          const contest = await contestsCollection.findOne({
            _id: new ObjectId(id),
            creatorUid: req.user.uid,
          });
          if (!contest) return res.status(403).send({ error: "Forbidden" });

          if (contest.winner)
            return res.status(400).send({ error: "Winner already declared" });

          await contestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { winner } }
          );

          res.send({ success: true });
        } catch (error) {
          res.status(500).send({ error: "Failed" });
        }
      }
    );

    app.post("/submissions", verifyFirebaseToken, async (req, res) => {
      const {
        contestId,
        userUid,
        userEmail,
        userName,
        userPhotoURL,
        task,
        submittedAt,
      } = req.body;

      try {
        const payment = await paymentsCollection.findOne({
          userUid,
          contestId,
        });

        if (!payment) {
          return res.status(403).send({ error: "You must pay to submit" });
        }

        const existing = await submissionsCollection.findOne({
          userUid,
          contestId,
        });

        if (existing) {
          return res.status(400).send({ error: "You have already submitted" });
        }

        const submissionDoc = {
          contestId,
          userUid,
          userEmail,
          userName: userName || "Anonymous",
          userPhotoURL,
          task,
          submittedAt: new Date(submittedAt),
        };

        await submissionsCollection.insertOne(submissionDoc);

        res.send({ success: true });
      } catch (error) {
        console.error("Submission failed:", error);
        res.status(500).send({ error: "Failed to submit task" });
      }
    });

    app.get(
      "/check-submission/:uid/:contestId",
      verifyFirebaseToken,
      async (req, res) => {
        const { uid, contestId } = req.params;

        if (req.user.uid !== uid) {
          return res.status(403).send({ error: "Forbidden" });
        }

        const submission = await submissionsCollection.findOne({
          userUid: uid,
          contestId,
        });

        res.send({ submitted: !!submission });
      }
    );

    // //==================== PUBLIC ROUTES ====================////////.
    app.get("/contests", async (req, res) => {
      const contests = await contestsCollection
        .find({ status: "approved" })
        .sort({ participants: -1 })
        .toArray();
      res.send(contests);
    });

    app.get("/contest/:id", async (req, res) => {
      const contest = await contestsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!contest) return res.status(404).send({ error: "Contest not found" });
      res.send(contest);
    });

    app.get("/recent-winners", async (req, res) => {
      try {
        const winners = await contestsCollection
          .find({ winner: { $exists: true } })
          .sort({ "winner.declaredAt": -1 })
          .limit(3)
          .toArray();
        res.send(winners);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch winners" });
      }
    });

    app.get("/contests/search", async (req, res) => {
      const { category } = req.query;

      try {
        if (!category) {
          return res.send([]);
        }

        const searchRegex = new RegExp(`^${category}$`, "i");

        const results = await contestsCollection
          .find({
            status: "approved",
            category: searchRegex,
          })
          .toArray();

        res.send(results);
      } catch (error) {
        console.error("Category search failed:", error);
        res.status(500).send({ error: "Search failed" });
      }
    });

    app.get("/leaderboard", async (req, res) => {
      try {
        const pipeline = [
          {
            $lookup: {
              from: "contests",
              let: { winnerUid: { $toString: "$uid" } },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$winner.uid", "$$winnerUid"] },
                        { $eq: ["$status", "approved"] },
                      ],
                    },
                  },
                },
                { $project: { prize: 1 } },
              ],
              as: "wonContests",
            },
          },
          {
            $project: {
              displayName: 1,
              photoURL: 1,
              email: 1,
              uid: 1,
              wins: { $size: "$wonContests" },
              totalPrize: { $sum: "$wonContests.prize" },
            },
          },
          { $match: { wins: { $gt: 0 } } },
          { $sort: { wins: -1, totalPrize: -1 } },
        ];

        const leaderboard = await usersCollection.aggregate(pipeline).toArray();
        res.send(leaderboard);
      } catch (error) {
        console.error("Leaderboard error:", error);
        res.status(500).send({ error: "Failed to load leaderboard" });
      }
    });

    // ==================== PAYMENT ROUTES ====================

    app.post("/save-payment", verifyFirebaseToken, async (req, res) => {
      const { contestId } = req.body;

      try {
        const existing = await paymentsCollection.findOne({
          userUid: req.user.uid,
          contestId,
        });

        if (existing) {
          return res.send({ success: true, alreadyPaid: true });
        }

        const paymentDoc = {
          userUid: req.user.uid,
          userEmail: req.user.email,
          contestId,
          status: "succeeded",
          createdAt: new Date(),
        };

        await paymentsCollection.insertOne(paymentDoc);

        await contestsCollection.updateOne(
          { _id: new ObjectId(contestId) },
          { $inc: { participants: 1 } }
        );

        res.send({ success: true });
      } catch (error) {
        console.error("Save payment failed:", error);
        res.status(500).send({ error: "Failed to save payment" });
      }
    });

    app.get(
      "/check-payment/:uid/:contestId",
      verifyFirebaseToken,
      async (req, res) => {
        const { uid, contestId } = req.params;

        if (req.user.uid !== uid) {
          return res.status(403).send({ error: "Forbidden" });
        }

        const payment = await paymentsCollection.findOne({
          userUid: uid,
          contestId,
        });

        res.send({ paid: !!payment });
      }
    );

    app.get("/my-participated", verifyFirebaseToken, async (req, res) => {
      const payments = await paymentsCollection
        .find({ userUid: req.user.uid })
        .toArray();

      const contestIds = payments.map((p) => p.contestId);

      if (contestIds.length === 0) {
        return res.send([]);
      }

      const contests = await contestsCollection
        .find({ _id: { $in: contestIds.map((id) => new ObjectId(id)) } })
        .sort({ deadline: 1 })
        .toArray();

      res.send(contests);
    });

    // ==================== STRIPE CHECKOUT ====================.
    app.post(
      "/create-checkout-session",
      verifyFirebaseToken,
      async (req, res) => {
        const { contestId } = req.body;

        try {
          const contest = await contestsCollection.findOne({
            _id: new ObjectId(contestId),
          });
          if (!contest || contest.status !== "approved") {
            return res.status(400).send({ error: "Contest not approved" });
          }
          if (new Date(contest.deadline) < new Date()) {
            return res.status(400).send({ error: "Contest ended" });
          }

          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: { name: `Entry: ${contest.name}` },
                  unit_amount: contest.price * 100,
                },
                quantity: 1,
              },
            ],
            mode: "payment",
            success_url: `${process.env.CLIENT_URL}/contest/${contestId}?payment=success`,
            cancel_url: `${process.env.CLIENT_URL}/contest/${contestId}?payment=cancel`,
          });

          res.send({ url: session.url });
        } catch (error) {
          console.error("Checkout failed:", error);
          res.status(500).send({ error: "Payment failed" });
        }
      }
    );

    console.log("MongoDB connected!");
  } catch (error) {
    console.error("Startup failed:", error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => res.send("ContestHub Backend Running!"));

app.listen(port, () => console.log(`Server running on port ${port}`));
