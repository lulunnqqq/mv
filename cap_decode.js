const BASE_URL = "https://cap.hexa.su/0737428d64";
const HEADERS = {
  Host: "cap.hexa.su",
  Connection: "keep-alive",
  "sec-ch-ua-platform": '"macOS"',
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  DNT: "1",
  "sec-ch-ua-mobile": "?0",
  Accept: "*/*",
  Origin: "https://hexa.su",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  Referer: "https://hexa.su/",
  "Accept-Language": "en-US,en;q=0.9",
};

// =============================================================
// Function i(e, t) from cap_hexa.js lines 7-27
// FNV-1a hash seed → xorshift PRNG → generate hex string
// =============================================================
function generateHex(seed, length) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  hash = hash >>> 0;

  let result = "";
  function xorshift() {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return hash >>> 0;
  }

  while (result.length < length) {
    result += xorshift().toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

// =============================================================
// Parse hex string → Uint8Array (replacement for Buffer.from)
// =============================================================
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// =============================================================
// Solve PoW: find nonce where SHA-256(salt + nonce) matches target
// Logic mirrors the worker blob in cap_hexa.js line 142
// Uses crypto.subtle (Web Crypto API) — works in both Node & Browser
// =============================================================
async function solveChallenge(salt, target) {
  const encoder = new TextEncoder();
  const totalBits = 4 * target.length;
  const fullBytes = Math.floor(totalBits / 8);
  const remainingBits = totalBits % 8;

  const paddedTarget = target.length % 2 === 0 ? target : target + "0";
  const targetBytes = hexToBytes(paddedTarget);

  const mask = remainingBits > 0 ? (255 << (8 - remainingBits)) & 255 : 0;

  let nonce = 0;
  while (true) {
    // Batch 5000 iterations per loop to reduce async overhead
    for (let b = 0; b < 5000; b++) {
      const input = encoder.encode(salt + nonce);
      const hashBuf = await crypto.subtle.digest("SHA-256", input);
      const hash = new Uint8Array(hashBuf);

      let match = true;
      for (let i = 0; i < fullBytes; i++) {
        if (hash[i] !== targetBytes[i]) {
          match = false;
          break;
        }
      }
      if (match && remainingBits > 0) {
        if ((hash[fullBytes] & mask) !== (targetBytes[fullBytes] & mask)) {
          match = false;
        }
      }

      if (match) return nonce;
      nonce++;
    }
  }
}

// =============================================================
// Solve multiple challenges with limited concurrency
// =============================================================
async function solveChallenges(challenges, concurrency) {
  const results = new Array(challenges.length);
  let completed = 0;
  let next = 0;

  async function worker() {
    while (next < challenges.length) {
      const idx = next++;
      const [salt, target] = challenges[idx];
      results[idx] = await solveChallenge(salt, target);
      completed++;
      console.log(`  Solved: ${completed}/${challenges.length}`);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, challenges.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

// =============================================================
// Main flow
// =============================================================
async function main() {
  // ---- Step 1: POST /challenge ----
  console.log("[1] Fetching challenge...");
  const challengeRes = await fetch(`${BASE_URL}/challenge`, {
    method: "POST",
    headers: HEADERS,
  });
  const challengeData = await challengeRes.json();

  if (challengeData.error) {
    throw new Error(`Challenge error: ${challengeData.error}`);
  }

  const { challenge, token } = challengeData;
  console.log(`    Token: ${token.substring(0, 50)}...`);
  console.log(
    `    Challenge params: c=${challenge.c}, s=${challenge.s}, d=${challenge.d}`
  );

  // ---- Step 2: Generate [salt, target] pairs from token + challenge params ----
  let challenges;
  if (Array.isArray(challenge)) {
    challenges = challenge;
  } else {
    let idx = 0;
    challenges = Array.from({ length: challenge.c }, () => {
      idx++;
      return [
        generateHex(`${token}${idx}`, challenge.s),
        generateHex(`${token}${idx}d`, challenge.d),
      ];
    });
  }

  console.log(`\n[2] Solving ${challenges.length} challenges...`);
  console.log(
    `    Example challenge[0]: salt=${challenges[0][0]}, target=${challenges[0][1]}`
  );

  // ---- Step 3: Solve PoW ----
  const startTime = Date.now();
  const concurrency = 6;
  const solutions = await solveChallenges(challenges, concurrency);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`    Done in ${elapsed}s`);
  console.log(
    `    Solutions preview: [${solutions.slice(0, 5).join(", ")}, ...]`
  );

  // ---- Step 4: POST /redeem ----
  console.log("\n[3] Redeeming token...");
  const redeemRes = await fetch(`${BASE_URL}/redeem`, {
    method: "POST",
    headers: {
      ...HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token, solutions }),
  });
  const redeemData = await redeemRes.json();

  if (redeemData.success) {
    console.log("    Success!");
    console.log(`    Cap Token: ${redeemData.token}`);
    console.log(`    Expires: ${redeemData.expires}`);

    // Write result to def.txt (used in CI pipeline)
    const output = JSON.stringify(redeemData, null, 2);
    try {
      const fs = await import("node:fs");
      fs.writeFileSync("def.txt", output);
      console.log("\n[4] Result written to def.txt");
    } catch {
      // fs not available (browser) — skip
    }
  } else {
    console.error("    Redeem failed:", redeemData.error || redeemData);
  }

  return redeemData;
}

main().catch((err) => {
  console.error("Fatal:", err.message);
});
