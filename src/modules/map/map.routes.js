const express = require("express");
const { renderMap, getGeeImageUrl, getTiffCompuesto, renderMapResult } = require("./map.controller");

const router = express.Router();

router.get("/", renderMap);
router.get("/result/:jobId", renderMapResult);
router.post("/gee-image", getGeeImageUrl);
router.post("/tiff-compuesto", getTiffCompuesto);

module.exports = router;