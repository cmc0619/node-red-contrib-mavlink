'use strict';

/**
 * A jQuery-ish DOM fake for editor-dialog harnesses: one element per selector,
 * a fresh element for any tag string, and a `$.getJSON` that records requests
 * instead of issuing them.
 *
 * It lived inside test/nodes/param-defs-editor.test.js, where it was already
 * the consolidation of four drifted copies. A second suite needing a select
 * that can actually be filled made it shared rather than copied a fifth time.
 * `length` and `.val()` always agree here, because the shared helpers branch on
 * `length` to tell an absent field from an empty one.
 */

/** `change.mavEnumTip` fires on `change`… */
function baseEvent(event) {
  return String(event).split('.')[0];
}

/** …but unbinds only alongside its own namespace. */
function eventNamespace(event) {
  return String(event).split('.').slice(1).join('.');
}

/** The slice of a jQuery result set the shared enum helpers actually use. */
function matchSet(list) {
  return {
    length: list.length,
    attr: (name) => (list[0] ? list[0].attr(name) : undefined),
  };
}

/**
 * The jQuery-ish scaffolding every harness in this file needs: one element per
 * selector, a fresh element for any tag string, and a `$.getJSON` that records
 * requests instead of issuing them.
 *
 * Four copies of this existed. They had already drifted — one still tested for
 * the literal `'<option></option>'` where the others test `charAt(0) === '<'`,
 * which is the same tag-detection bug this PR fixed once in the production
 * path. One copy is one place for that to be right.
 *
 * @param {object} values  seed values keyed by selector
 * @returns {{element: Function, $: Function, requests: object[]}}
 */
function makeDom(values = {}) {
  const elements = new Map();
  const requests = [];

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, new FakeElement(values[selector] || ''));
    }
    return elements.get(selector);
  }

  function $(selector) {
    // Any tag string builds a fresh element: the results panel renders its own
    // rows, and a shared stub would make every row the same node.
    if (String(selector).charAt(0) === '<') return new FakeElement();
    return element(selector);
  }

  $.getJSON = (url, query, success) => {
    const request = new FakeDeferred({ url, query });
    request.doneHandler = success;
    requests.push(request);
    return request;
  };

  return { element, $, requests };
}

class FakeElement {
  constructor(value = '') {
    // A found element, as in the real dialog: helpers branch on `.length` to
    // tell an absent field from an empty one.
    this.length = 1;
    this.value = value;
    this.label = '';
    this.attrs = {};
    // `handlers[event]` dispatches every binding for that event; `bound`
    // is the per-namespace registry behind it.
    this.handlers = {};
    this.bound = {};
    this.options = [];
    this.visible = true;
    this.disabled = false;
  }

  val(value) {
    // jQuery semantics for a multi-select: `.val()` answers an array of the
    // selected option values, and setting takes an array. The dialog's
    // bitmask picker is the consumer; single-value elements are unchanged.
    if (this.attrs.multiple !== undefined) {
      if (value === undefined) return this.selectedValues ? [...this.selectedValues] : [];
      this.selectedValues = new Set(
        (Array.isArray(value) ? value : [value]).map(String)
      );
      return this;
    }
    if (value === undefined) return this.value;
    this.value = String(value);
    return this;
  }

  text(value) {
    if (value === undefined) return this.label;
    this.label = String(value);
    return this;
  }

  attr(name, value) {
    if (value === undefined) return this.attrs[name];
    if (value === null) delete this.attrs[name];
    else this.attrs[name] = String(value);
    return this;
  }

  removeAttr(name) {
    delete this.attrs[name];
    return this;
  }

  prop(name, value) {
    if (value === undefined) return this[name];
    this[name] = value;
    return this;
  }

  empty() {
    this.options = [];
    return this;
  }

  append(option) {
    this.options.push(option);
    return this;
  }

  on(events, handler) {
    for (const spec of String(events).split(/\s+/)) {
      const base = baseEvent(spec);
      if (!this.bound[base]) this.bound[base] = [];
      this.bound[base].push({ ns: eventNamespace(spec), handler });
      this.rebind(base);
    }
    return this;
  }

  off(events) {
    for (const spec of String(events).split(/\s+/)) {
      const base = baseEvent(spec);
      if (!this.bound[base]) continue;
      const ns = eventNamespace(spec);
      // jQuery semantics, and the reason they matter here: `off('change.ns')`
      // unbinds only that namespace. Collapsing it to `off('change')` would let
      // a helper's own tip-sync silently unbind the dialog's change handler,
      // and the harness would stop seeing what a fill does to the value box.
      this.bound[base] = ns ? this.bound[base].filter((b) => b.ns !== ns) : [];
      this.rebind(base);
    }
    return this;
  }

  rebind(base) {
    if (!this.bound[base] || !this.bound[base].length) {
      delete this.handlers[base];
      return;
    }
    this.handlers[base] = (event) => {
      for (const b of (this.bound[base] || []).slice()) {
        b.handler.call(this, event || { preventDefault() {} });
      }
    };
  }

  trigger(event) {
    const handler = this.handlers[baseEvent(event)];
    if (handler) handler({ preventDefault() {} });
    return this;
  }

  /**
   * Enough of a selector engine for the shared enum helpers: they ask for an
   * option by value (`ensureSavedEnumOption`) and for the selected one
   * (`bindSelectTitleSync`). A miss returns an empty set, as jQuery does.
   */
  find(selector) {
    const byValue = /^option\[value="(.*)"\]$/.exec(String(selector));
    if (byValue) return matchSet(this.options.filter((o) => o.val() === byValue[1]));
    if (String(selector) === 'option:selected') {
      return matchSet(this.options.filter((o) => o.val() === this.value));
    }
    return matchSet([]);
  }

  userClick() {
    if (this.disabled || !this.handlers.click) return;
    this.handlers.click.call(this, { preventDefault() {} });
  }

  toggle(visible) {
    this.visible = !!visible;
    return this;
  }

  show() {
    this.visible = true;
    return this;
  }

  hide() {
    this.visible = false;
    return this;
  }
}

class FakeDeferred {
  constructor(options) {
    this.options = options;
    this.doneHandler = null;
    this.failHandler = null;
    this.alwaysHandler = null;
  }

  done(handler) {
    this.doneHandler = handler;
    return this;
  }

  fail(handler) {
    this.failHandler = handler;
    return this;
  }

  always(handler) {
    this.alwaysHandler = handler;
    return this;
  }

  resolve(data) {
    if (this.doneHandler) this.doneHandler(data);
    if (this.alwaysHandler) this.alwaysHandler();
  }

  reject(xhr) {
    if (this.failHandler) this.failHandler(xhr);
    if (this.alwaysHandler) this.alwaysHandler();
  }
}

module.exports = { makeDom, FakeElement, FakeDeferred };
