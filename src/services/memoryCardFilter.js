/**
 * Stateful streaming parser for filtering MEMORY_CARD tags from streaming text.
 * Handles tags that are split across multiple chunks during streaming.
 */

function createMemoryCardFilter() {
    const START = "<MEMORY_CARD>";
    const END = "</MEMORY_CARD>";
    const START_TAIL = Math.max(0, START.length - 1);
    const END_TAIL = Math.max(0, END.length - 1);
    let mode = "normal";      // "normal" | "capturing"
    let carry = "";           // small tail to detect split tags
    let cardBuf = "";
    let cardDone = false;

    function feed(chunk = "") {
        let text = carry + (chunk || "");
        let uiOut = "";

        while (text.length) {
            if (mode === "normal") {
                const i = text.indexOf(START);
                if (i === -1) {
                    // keep a tail so a split START across chunks is detected
                    const cutoff = Math.max(0, text.length - START_TAIL);
                    uiOut += text.slice(0, cutoff);
                    carry = text.slice(cutoff);
                    text = "";
                } else {
                    uiOut += text.slice(0, i);                 // emit clean text before tag
                    text = text.slice(i + START.length);
                    mode = "capturing";
                    cardBuf = "";
                    carry = "";
                }
            } else {
                // capturing until END
                const j = text.indexOf(END);
                if (j === -1) {
                    // Append everything except the tail reserved for END detection
                    const cutoff = Math.max(0, text.length - END_TAIL);
                    cardBuf += text.slice(0, cutoff);
                    carry = text.slice(cutoff);
                    text = "";

                    // Safety limit to prevent memory issues with malformed tags
                    if (cardBuf.length > 10000) {  // ~2500 tokens max
                        console.error('[MEMORY_CARD] Card too large, discarding and returning to normal mode');
                        mode = "normal";
                        cardBuf = "";
                        carry = "";
                    }
                } else {
                    cardBuf += text.slice(0, j);
                    text = text.slice(j + END.length);
                    carry = "";
                    cardDone = true;          // we captured the card
                    mode = "normal";          // ignore any text after END (rare)
                    // loop again to process anything after END in this same chunk
                }
            }
        }
        const card = cardDone ? cardBuf.trim() : null;
        if (cardDone) {
            cardDone = false;
            cardBuf = "";
        }
        return { ui: uiOut, card };
    }

    function flush() {
        // Only leftover normal text is safe to emit; discard partial tags
        const tail = mode === "normal" ? carry : "";
        carry = "";
        const card = cardDone ? cardBuf.trim() : null;
        if (cardDone) {
            cardDone = false;
            cardBuf = "";
        }
        return { ui: tail, card };
    }

    return { feed, flush };
}

module.exports = { createMemoryCardFilter };
