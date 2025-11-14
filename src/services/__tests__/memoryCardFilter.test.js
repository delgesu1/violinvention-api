const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryCardFilter } = require('../memoryCardFilter');

test('captures card within single chunk and resets state after emitting', () => {
    const filter = createMemoryCardFilter();
    const chunk = 'Intro <MEMORY_CARD>{"goal":"practice"}</MEMORY_CARD> outro';

    const first = filter.feed(chunk);

    assert.equal(first.ui, 'Intro ');
    const flush = filter.flush();
    assert.equal(first.card, '{"goal":"practice"}');
    assert.equal(flush.ui, ' outro');

    // Subsequent chunks should no longer emit the previous card
    const second = filter.feed('No card here');
    assert.equal(second.card, null);
});

test('handles heavily chunked MEMORY_CARD payloads without duplicating characters', () => {
    const filter = createMemoryCardFilter();
    const cardJson = '{"goal":"Master vibrato","decisions":["Practice"],"open_q":[],"techniques":[],"lesson_context":"intermediate"}';
    const cardWrapped = `<MEMORY_CARD>${cardJson}</MEMORY_CARD>`;

    const stream = ['Lead text '];
    for (let i = 0; i < cardWrapped.length; i += 4) {
        stream.push(cardWrapped.slice(i, i + 4));
    }
    stream.push(' trailer');

    let captured = null;
    let uiOut = '';

    for (const piece of stream) {
        const { ui, card } = filter.feed(piece);
        uiOut += ui;
        if (card) captured = card;
    }

    const flushed = filter.flush();
    uiOut += flushed.ui;
    if (!captured) captured = flushed.card;

    assert.equal(uiOut, 'Lead text  trailer');
    assert.equal(captured, cardJson);
});

test('flush discards partial card data when END tag never arrives', () => {
    const filter = createMemoryCardFilter();
    const partial = filter.feed('Intro <MEMORY_CARD>{"goal":"work"}');

    assert.equal(partial.ui, 'Intro ');
    assert.equal(partial.card, null);

    const flushed = filter.flush();
    assert.equal(flushed.card, null);
    assert.equal(flushed.ui, '');
});
