// ===== Where the canvas strip is, so the reference strip can follow =====
//
// In a longstrip chapter the reference sidebar is not one raw page any more, it
// is the whole chapter's raws in a column beside the canvas's - and two columns
// of the same chapter that scroll independently are worse than one, because the
// reader has to keep re-finding their place in the one they are not driving.
//
// So the canvas leads and the sidebar follows. What travels between them is a
// scroll fraction rather than a pixel offset (see `scrollFraction` in strip.js):
// the two columns are the same chapter at different widths, so their scroll
// heights differ.
//
// A module of state rather than a prop or an event because the two components
// are siblings under EditorRoot with no relationship to each other, and the
// alternative - the canvas reaching into the sidebar's DOM - puts one
// component's element in another component's file.
//
// The traffic is one-way by construction: nothing here is written by the
// sidebar, so a scroll the user performs in the sidebar itself cannot echo back
// into the canvas. That is also why there is no guard flag on the write - there
// is no second writer to guard against, and the sidebar's own wheel goes on
// working until the next canvas scroll puts it back in step.
export const stripScroll = $state({
  // 0 at the top of the chapter, 1 at the bottom.
  fraction: 0,
  // Bumped on every publish, including one that lands on the same fraction.
  // The follower re-applies on `seq` rather than on `fraction` so that a
  // sidebar the user has scrolled by hand is pulled back into step by the next
  // canvas scroll, even when the canvas has not actually moved.
  seq: 0,
});

export function publishStripScroll(fraction) {
  stripScroll.fraction = fraction;
  stripScroll.seq++;
}

// ===== A jump to a box, for the canvas strip to scroll to =====
//
// The other direction: something outside the canvas - the queue's "needs
// review" list - wants a box brought into view. In a paged chapter turning to
// its page is the whole of that; in a strip the page is already on screen
// somewhere in the column and only a scroll reaches the box, and the scroll
// container is the canvas's own. Same shape as above for the same reason: the
// list and the canvas are strangers, and this keeps the canvas's element in the
// canvas's file.
//
// The box is looked up on the current page when the canvas answers, so the
// caller turns to its page and selects it first - as it does in a paged
// chapter - and asks for the scroll last.
export const stripReveal = $state({ boxId: null, seq: 0 });

export function revealInStrip(boxId) {
  stripReveal.boxId = boxId;
  stripReveal.seq++;
}
