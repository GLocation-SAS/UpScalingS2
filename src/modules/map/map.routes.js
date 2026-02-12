const express = require("express");
const { renderMap, getGeeImageUrl, renderMapResult } = require("./map.controller");

const router = express.Router();

router.get("/", renderMap);
router.get("/result/:jobId", renderMapResult);
router.post("/gee-image", getGeeImageUrl);

module.exports = router;