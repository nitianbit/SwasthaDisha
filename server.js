import 'reflect-metadata';
import express from 'express'
const app = express();

import dotenv from 'dotenv';
import path from 'path'
import cors from 'cors'

import { CONFIG } from './src/config/config.js';
import settings from './settings.js';
import { connectDB } from './src/db/index.js';
import configureRoutes from './src/routes/index.js';



dotenv.config({ path: path.resolve(settings.PROJECT_DIR, `.env`) });

app.use(cors());
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

app.use("/", (req, res, next) => {
    // res.send("Welcome to the server!");
    console.log("Welcome to the server!")
    next();
});

connectDB()
configureRoutes(app)

app.listen(CONFIG.PORT, () => console.log(`Server running on port ${CONFIG.PORT}`))


