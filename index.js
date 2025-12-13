const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");

const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(cors());

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
    const contestsCollection = db.collection("contests");

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
