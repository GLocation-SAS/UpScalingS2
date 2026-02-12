const express = require("express");
const path = require('path');
const { renderMap, getGeeImageUrl, renderMapResult } = require("./map.controller");

const router = express.Router();

router.get("/result/:jobId", renderMapResult);
router.get("/map-gee-selector", renderMap);
router.post("/gee-image", getGeeImageUrl);

module.exports = router;