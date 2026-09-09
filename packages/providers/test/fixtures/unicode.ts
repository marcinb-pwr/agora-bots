export const unicodeFixture = {
  chunks: ["Café", " — ", "naïve 👩🏽‍💻", ". ", "مَرْحَبًا", " नमस्ते"],
  text: "Café — naïve 👩🏽‍💻. مَرْحَبًا नमस्ते",
  inputTokens: 7,
  outputTokens: 12,
} as const;
