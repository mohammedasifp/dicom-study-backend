const words = (text) => (text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function sharedWordCount(aiWords, finalWords) {
  let prev = new Array(finalWords.length + 1).fill(0);
  for (const a of aiWords) {
    const row = [0];
    for (let j = 0; j < finalWords.length; j++) {
      row.push(a === finalWords[j] ? prev[j] + 1 : Math.max(prev[j + 1], row[j]));
    }
    prev = row;
  }
  return prev[finalWords.length];
}

export function computeAuthorship(report) {
  const pairs = [
    ...report.suggestions
      .filter((s) => s.decision !== "discarded")
      .map((s) => [s.aiText, s.decision === "edited" ? s.reviewerText : s.aiText]),
    [report.findings?.aiText, report.findings?.text],
    [report.impression?.aiText, report.impression?.text],
  ];

  let aiWords = 0;
  let totalWords = 0;
  for (const [aiText, finalText] of pairs) {
    const finalWords = words(finalText);
    totalWords += finalWords.length;
    aiWords += sharedWordCount(words(aiText), finalWords);
  }

  const aiPercent = totalWords ? Math.round((aiWords / totalWords) * 1000) / 10 : 0;
  return {
    aiPercent,
    humanPercent: totalWords ? Math.round((100 - aiPercent) * 10) / 10 : 0,
    aiWords,
    totalWords,
    computedAt: new Date(),
  };
}
