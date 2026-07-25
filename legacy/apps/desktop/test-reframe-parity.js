// Test de parité pour compute_crop_rect
// Copie de la fonction depuis reframe.ts

function computeCropRect(sourceWidth, sourceHeight, outputWidth, outputHeight, focusX, focusY, zoom) {
  const outputAspect = outputWidth / outputHeight;
  const sourceAspect = sourceWidth / sourceHeight;

  let cropW, cropH;

  if (sourceAspect > outputAspect) {
    cropH = 1.0 / zoom;
    cropW = (cropH * outputAspect) / sourceAspect;
  } else {
    cropW = 1.0 / zoom;
    cropH = (cropW * sourceAspect) / outputAspect;
  }

  cropW = Math.min(cropW, 1.0);
  cropH = Math.min(cropH, 1.0);

  const cropX = Math.max(0, Math.min(1 - cropW, focusX - cropW / 2));
  const cropY = Math.max(0, Math.min(1 - cropH, focusY - cropH / 2));

  return { cropX, cropY, cropWidth: cropW, cropHeight: cropH };
}

console.log('=== Tests TypeScript/JavaScript ===');

// Test 1
const result1 = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, 1.0);
console.log(`Test 1 - JS: cropX=${result1.cropX.toFixed(6)}, cropY=${result1.cropY.toFixed(6)}, cropWidth=${result1.cropWidth.toFixed(6)}, cropHeight=${result1.cropHeight.toFixed(6)}`);

// Test 2
const result2 = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, 1.2);
console.log(`Test 2 - JS: cropX=${result2.cropX.toFixed(6)}, cropY=${result2.cropY.toFixed(6)}, cropWidth=${result2.cropWidth.toFixed(6)}, cropHeight=${result2.cropHeight.toFixed(6)}`);

// Test 3
const result3 = computeCropRect(1920, 1080, 540, 960, 0.0, 0.5, 1.0);
console.log(`Test 3 - JS: cropX=${result3.cropX.toFixed(6)}, cropY=${result3.cropY.toFixed(6)}, cropWidth=${result3.cropWidth.toFixed(6)}, cropHeight=${result3.cropHeight.toFixed(6)}`);

// Test 4
const result4 = computeCropRect(1920, 1080, 540, 960, 1.0, 0.5, 1.0);
console.log(`Test 4 - JS: cropX=${result4.cropX.toFixed(6)}, cropY=${result4.cropY.toFixed(6)}, cropWidth=${result4.cropWidth.toFixed(6)}, cropHeight=${result4.cropHeight.toFixed(6)}`);

// Résultats Python
const pythonResults = [
  { cropX: 0.341797, cropY: 0.000000, cropWidth: 0.316406, cropHeight: 1.000000 },
  { cropX: 0.368164, cropY: 0.083333, cropWidth: 0.263672, cropHeight: 0.833333 },
  { cropX: 0.000000, cropY: 0.000000, cropWidth: 0.316406, cropHeight: 1.000000 },
  { cropX: 0.683594, cropY: 0.000000, cropWidth: 0.316406, cropHeight: 1.000000 },
];

const jsResults = [result1, result2, result3, result4];

let allMatch = true;
const tolerance = 0.001;

jsResults.forEach((jsResult, i) => {
  const pyResult = pythonResults[i];
  const xDiff = Math.abs(jsResult.cropX - pyResult.cropX);
  const yDiff = Math.abs(jsResult.cropY - pyResult.cropY);
  const wDiff = Math.abs(jsResult.cropWidth - pyResult.cropWidth);
  const hDiff = Math.abs(jsResult.cropHeight - pyResult.cropHeight);

  if (xDiff > tolerance || yDiff > tolerance || wDiff > tolerance || hDiff > tolerance) {
    console.error(`❌ Test ${i + 1} FAILED: Divergence Python/JS`);
    console.error(`  X diff: ${xDiff}, Y diff: ${yDiff}, W diff: ${wDiff}, H diff: ${hDiff}`);
    allMatch = false;
  } else {
    console.log(`✅ Test ${i + 1} PASSED: Parité Python/JS confirmée (diff < ${tolerance})`);
  }
});

if (allMatch) {
  console.log('\n✅ SUCCÈS: Tous les tests de parité passés !');
  process.exit(0);
} else {
  console.error('\n❌ ÉCHEC: Divergence Python/JavaScript détectée');
  process.exit(1);
}
