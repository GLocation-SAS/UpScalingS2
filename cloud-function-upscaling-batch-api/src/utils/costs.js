const GEMINI_INPUT_PRICE_PER_M = parseFloat(process.env.GEMINI_INPUT_PRICE_PER_M || '0.10');
const GEMINI_OUTPUT_TEXT_PRICE_PER_M = parseFloat(process.env.GEMINI_OUTPUT_TEXT_PRICE_PER_M || '0.40');
const GEMINI_OUTPUT_IMAGE_PRICE_PER_M = parseFloat(process.env.GEMINI_OUTPUT_IMAGE_PRICE_PER_M || '30.00');

function calculateCost(tokens) {
    const inputCost = (tokens.input / 1_000_000) * GEMINI_INPUT_PRICE_PER_M;
    const outputImageCost = (tokens.output / 1_000_000) * GEMINI_OUTPUT_IMAGE_PRICE_PER_M;
    const outputTextCost = (tokens.output / 1_000_000) * GEMINI_OUTPUT_TEXT_PRICE_PER_M;
    const totalCost = inputCost + outputImageCost;

    return { inputCost, outputImageCost, outputTextCost, totalCost };
}

module.exports = { calculateCost };
