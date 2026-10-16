// The page side of the HTML bridge: plain ES2017 that runs inside the sandboxed frame as the first
// script of the built document. It defines window.canvas and speaks { channel: 'agent-canvas', v: 1 }.
// Kept as a raw string (no bundler transforms) so nothing the app build injects can leak into the frame.

export type BridgeConfig = {
  view: { id: string; revision: number; title: string };
  appearance: 'light' | 'dark';
  variables: Record<string, string>;
  /** The draft restored on load: what a previous load posted as `state`. */
  state: unknown;
  limits: { action: number; dataBytes: number; draftBytes: number };
  /** [builtLine, sourceLine | label] in built-line order, so errors cite the agent's own line numbers. */
  lines: Array<[number, number | string]>;
};

/** Expects a `config` binding (BridgeConfig) in scope. Contains no backticks, `${`, `</script` or `<!--`. */
export const BRIDGE_SOURCE = String.raw`'use strict';
var CHANNEL = 'agent-canvas', LIMITS = config.limits, root = document.documentElement, host = window.parent;
var themeStyle = document.getElementById('canvas-theme');
var hasOwn = Object.prototype.hasOwnProperty, each = Array.prototype.forEach;

function post(type, body) {
  var message = { channel: CHANNEL, v: 1, type: type };
  if (body) for (var key in body) message[key] = body[key];
  try { host.postMessage(message, '*'); } catch (error) { console.warn('Agent Canvas could not post a message:', error); }
}
function toJson(value, what) {
  var text;
  try { text = JSON.stringify(value === undefined ? null : value); }
  catch (error) { throw new TypeError(what + ' must be JSON data: ' + error.message); }
  return text === undefined ? 'null' : text;
}

var reportedCount = 0, reported = {};
function report(message) {
  message = String(message).slice(0, 1000);
  if (hasOwn.call(reported, message) || reportedCount >= 20) return;
  reported[message] = true; reportedCount++;
  post('error', { message: message });
}
function documentPlace(line) {
  var found = null, lines = config.lines;
  for (var i = 0; i < lines.length && lines[i][0] <= line; i++) found = lines[i];
  if (!found || !line) return '';
  return typeof found[1] === 'number' ? 'line ' + (found[1] + line - found[0]) : 'in ' + found[1];
}
function place(file, line) {
  file = String(file || '');
  var match = /page-script-at-line-(\d+)\.js$/.exec(file);
  if (match) return line ? 'line ' + (Number(match[1]) + line - 1) : '';
  if (/canvas-bridge\.js$/.test(file)) return 'in the Canvas bridge';
  match = /canvas-lib-(.+)\.js$/.exec(file);
  if (match) return 'in bundled library ' + match[1];
  return file === 'about:srcdoc' ? documentPlace(line) : '';
}
function stackPlace(stack) {
  var rows = String(stack || '').split('\n'), fallback = '';
  for (var i = 0; i < rows.length; i++) {
    var match = /((?:about:srcdoc|[\w.-]+\.js|[a-z]+:\/\/[^\s()]+?)):(\d+):(\d+)\)?\s*$/.exec(rows[i]);
    if (!match) continue;
    var where = place(match[1], Number(match[2]));
    if (/^line /.test(where)) return fallback ? where + ', calling ' + fallback.replace(/^in /, '') : where;
    if (!where) return fallback;
    if (!fallback) fallback = where;
  }
  return fallback;
}
function describe(error) {
  if (error && typeof error === 'object' && error.message) return (error.name && error.name !== 'Error' ? error.name + ': ' : '') + error.message;
  return String(error);
}
function reportError(error) {
  var where = error && error.stack ? stackPlace(error.stack) : '';
  report(describe(error) + (where ? ' (' + where + ')' : ''));
}

var blocked = {};
var BLOCK_HINTS = {
  script: 'Use a bundled library (canvas:lib/NAME) or inline the code.',
  stylesheet: 'Put the CSS in a <style> element.',
  image: 'Draw it with inline SVG or CSS, or embed it as a data: URL.',
  font: 'Use the theme fonts var(--font-sans) and var(--font-mono).',
  media: 'Embed small media as a data: URL.',
  request: 'Embed the data in the page instead of requesting it.',
  frame: 'Pages cannot embed other sites; link to them instead.'
};
function blockedResource(url, kind) {
  if (!url || hasOwn.call(blocked, url)) return;
  blocked[url] = true;
  report('Could not load ' + kind + ' ' + url.slice(0, 300) + ': Canvas pages have no network access. ' + (BLOCK_HINTS[kind] || ''));
}
function directiveKind(directive) {
  directive = String(directive || '');
  if (/^script/.test(directive) || /^worker/.test(directive)) return 'script';
  if (/^style/.test(directive)) return 'stylesheet';
  if (/^img/.test(directive)) return 'image';
  if (/^font/.test(directive)) return 'font';
  if (/^media/.test(directive)) return 'media';
  if (/^connect/.test(directive)) return 'request';
  if (/^(frame|child|object)/.test(directive)) return 'frame';
  return directive || 'resource';
}
window.addEventListener('error', function (event) {
  var target = event.target;
  if (target && target !== window && target.nodeType === 1) {
    var name = target.tagName.toLowerCase(), url = target.currentSrc || target.src || target.href || '';
    if (url && typeof url === 'object') url = url.baseVal || '';
    blockedResource(String(url), name === 'script' ? 'script' : name === 'link' ? 'stylesheet' : name === 'img' || name === 'image' ? 'image' : name === 'iframe' ? 'frame' : 'media');
    return;
  }
  var where = (event.error && event.error.stack && stackPlace(event.error.stack)) || place(event.filename, event.lineno);
  var text = event.error ? describe(event.error) : String(event.message || 'Script error').replace(/^Uncaught /, '');
  report(text + (where ? ' (' + where + ')' : ''));
}, true);
window.addEventListener('unhandledrejection', function (event) {
  var reason = event.reason;
  if (reason && reason.canvasSend) return;
  var where = reason && reason.stack ? stackPlace(reason.stack) : '';
  report('Unhandled promise rejection: ' + describe(reason) + (where ? ' (' + where + ')' : ''));
});
document.addEventListener('securitypolicyviolation', function (event) {
  var url = event.blockedURI || '';
  if (url && url !== 'inline' && url !== 'eval') blockedResource(url, directiveKind(event.effectiveDirective || event.violatedDirective));
});

// Network paths the frame CSP cannot close. Chrome prerenders and preconnects for these link types and speculation rules
// even under default-src 'none', and CSP does not govern WebRTC at all. A nested frame (iframe, frame, object, embed)
// would bring fresh globals that none of these guards reach, so a page cannot have one. checkHtml refuses all of them in
// the source; the guards below catch pages that build them at run time. They run before any page script and use only
// natives captured here, called through Reflect.apply, so a page that redefines built-ins (Function.prototype.call,
// RegExp.prototype.exec, a node's own localName) neither changes their answers nor gets hold of an unguarded native.
['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSctpTransport', 'RTCDtlsTransport'].forEach(function (name) {
  try { delete window[name]; Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (error) { /* already gone */ }
});
var apply = Reflect.apply, defineProperty = Object.defineProperty, ownDescriptor = Object.getOwnPropertyDescriptor, toText = String, Refusal = TypeError;
var regExec = RegExp.prototype.exec, lower = String.prototype.toLowerCase, sliceText = String.prototype.slice, lastIndexOf = String.prototype.lastIndexOf, copyList = Array.prototype.slice;
var weakHas = WeakSet.prototype.has, weakAdd = WeakSet.prototype.add;
function getter(proto, name) { var d = proto && ownDescriptor(proto, name); return d && d.get; }
var nodeTypeOf = getter(Node.prototype, 'nodeType'), localNameOf = getter(Element.prototype, 'localName'), listLength = getter(NodeList.prototype, 'length');
var firstChildOf = getter(Node.prototype, 'firstChild'), nextSiblingOf = getter(Node.prototype, 'nextSibling'), dataOf = getter(CharacterData.prototype, 'data');
var attrNameOf = getter(Attr.prototype, 'localName'), attrValueOf = getter(Attr.prototype, 'value'), contentOf = getter(HTMLTemplateElement.prototype, 'content');
var nativeGetAttribute = Element.prototype.getAttribute, nativeSetAttribute = Element.prototype.setAttribute, nativeSetAttributeNS = Element.prototype.setAttributeNS;
var nativeRemoveAttribute = Element.prototype.removeAttribute, nativeRemove = Element.prototype.remove;
var queryElement = Element.prototype.querySelector, queryElementAll = Element.prototype.querySelectorAll;
var queryFragment = DocumentFragment.prototype.querySelector, queryFragmentAll = DocumentFragment.prototype.querySelectorAll;

function matches(pattern, text) { return apply(regExec, pattern, [text]) !== null; }
function lowerText(text) { return apply(lower, text, []); }
function nodeType(value) {
  if (value === null || typeof value !== 'object') return 0;
  try { return apply(nodeTypeOf, value, []); } catch (error) { return 0; }
}
function nameOf(el) { return lowerText(apply(localNameOf, el, [])); }
function queryFirst(root, selector) {
  var type = nodeType(root);
  return type === 1 ? apply(queryElement, root, [selector]) : type === 11 ? apply(queryFragment, root, [selector]) : null;
}
function queryEach(root, selector, visit) {
  var type = nodeType(root), list = type === 1 ? apply(queryElementAll, root, [selector]) : type === 11 ? apply(queryFragmentAll, root, [selector]) : null;
  if (list) for (var i = 0, n = apply(listLength, list, []); i < n; i++) visit(list[i]);
}
function quietly(message) { try { report(message); } catch (error) { /* the refusal stands */ } }

var FRAME_SELECTOR = 'iframe, frame, object, embed, fencedframe', FRAME_MARKUP = /<(?:iframe|frame|object|embed|fencedframe)[\t\n\f\r \/>]/i;
var FRAME_REFUSAL = 'Agent Canvas blocked a nested frame (iframe, frame, object or embed): Canvas pages cannot embed frames. Build the content in the page itself, and link to other sites with <a href>.';
function isFrameName(name) {
  name = lowerText(name);
  return name === 'iframe' || name === 'frame' || name === 'object' || name === 'embed' || name === 'fencedframe';
}
function isFrame(node) { return nodeType(node) === 1 && isFrameName(apply(localNameOf, node, [])); }
function refuseFrame() { quietly(FRAME_REFUSAL); return new Refusal(FRAME_REFUSAL); }
function removeFrame(el) { apply(nativeRemove, el, []); quietly(FRAME_REFUSAL); }

var SPECULATIVE_REL = /(?:^|\s)(?:prerender|prefetch|dns-prefetch|preconnect)(?:\s|$)/i, SPECULATION_TYPE = /^\s*speculationrules\s*$/i;
function refuse() { quietly('Agent Canvas blocked a prerender, prefetch, preconnect or speculation rule: Canvas pages have no network access.'); }
// By attribute name alone, since an attribute node can get its value before it has an element.
function speculative(name, value) {
  name = lowerText(name);
  return (name === 'rel' && matches(SPECULATIVE_REL, value)) || (name === 'type' && matches(SPECULATION_TYPE, value));
}
function neutralize(el) {
  if (nodeType(el) !== 1) return;
  var name = nameOf(el), value;
  if (name === 'link' && (value = apply(nativeGetAttribute, el, ['rel'])) !== null && speculative('rel', value)) { apply(nativeRemoveAttribute, el, ['rel']); refuse(); }
  else if (name === 'script' && (value = apply(nativeGetAttribute, el, ['type'])) !== null && speculative('type', value)) { apply(nativeSetAttribute, el, ['type', 'text/plain']); refuse(); }
}
// Speculative links and scripts in a subtree, template contents (declarative shadow roots) included.
function scrub(node) {
  neutralize(node);
  queryEach(node, 'link[rel], script[type], template', function (el) {
    if (nameOf(el) !== 'template') { neutralize(el); return; }
    var content = null;
    try { content = apply(contentOf, el, []); } catch (error) { /* not an HTML template */ }
    if (content) scrub(content);
  });
}

// Creation and attributes.
[[Document.prototype, 'createElement', 0], [Document.prototype, 'createElementNS', 1]].forEach(function (entry) {
  var native = entry[0][entry[1]], at = entry[2];
  entry[0][entry[1]] = function () {
    var args = apply(copyList, arguments, []);
    if (args.length > at) {
      var name = args[at] = toText(args[at]), colon = apply(lastIndexOf, name, [':']);
      if (isFrameName(colon < 0 ? name : apply(sliceText, name, [colon + 1]))) throw refuseFrame();
    }
    return apply(native, this, args);
  };
});
// No path above is left to put a frame in the document; if one lands anyway, its window still stays out of reach.
[typeof HTMLIFrameElement === 'function' && HTMLIFrameElement, typeof HTMLFrameElement === 'function' && HTMLFrameElement,
  typeof HTMLObjectElement === 'function' && HTMLObjectElement, typeof HTMLEmbedElement === 'function' && HTMLEmbedElement].forEach(function (type) {
  if (!type) return;
  ['contentWindow', 'contentDocument'].forEach(function (name) {
    var d = ownDescriptor(type.prototype, name);
    if (d && d.get) defineProperty(type.prototype, name, { configurable: false, enumerable: d.enumerable, get: function () { return null; } });
  });
  if (typeof type.prototype.getSVGDocument === 'function') defineProperty(type.prototype, 'getSVGDocument', { configurable: false, writable: false, enumerable: true, value: function () { return null; } });
});
Element.prototype.setAttribute = function (name, value) {
  name = toText(name); value = toText(value);
  if (speculative(name, value)) { refuse(); return; }
  return apply(nativeSetAttribute, this, [name, value]);
};
Element.prototype.setAttributeNS = function (namespace, name, value) {
  name = toText(name); value = toText(value);
  var colon = apply(lastIndexOf, name, [':']);
  if (speculative(colon < 0 ? name : apply(sliceText, name, [colon + 1]), value)) { refuse(); return; }
  return apply(nativeSetAttributeNS, this, [namespace, name, value]);
};
[[Element.prototype, ['setAttributeNode', 'setAttributeNodeNS']], [NamedNodeMap.prototype, ['setNamedItem', 'setNamedItemNS']]].forEach(function (entry) {
  entry[1].forEach(function (method) {
    var native = entry[0][method];
    if (typeof native !== 'function') return;
    entry[0][method] = function (attr) {
      if (nodeType(attr) === 2 && speculative(apply(attrNameOf, attr, []), apply(attrValueOf, attr, []))) { refuse(); return null; }
      return apply(native, this, arguments);
    };
  });
});
function guardSetter(proto, property, convert) {
  var d = proto && ownDescriptor(proto, property);
  if (!d || !d.set) return;
  defineProperty(proto, property, { configurable: true, enumerable: d.enumerable, get: d.get, set: function (value) {
    var checked = convert(this, value);
    if (checked.refuse) { refuse(); return; }
    apply(d.set, this, [checked.value]);
  } });
}
function textCheck(name) {
  return function (target, value) { value = toText(value); return { value: value, refuse: speculative(name, value) }; };
}
guardSetter(HTMLLinkElement.prototype, 'rel', textCheck('rel'));
guardSetter(HTMLScriptElement.prototype, 'type', textCheck('type'));
guardSetter(HTMLLinkElement.prototype, 'relList', textCheck('rel'));
// An attribute node's value, however it is set.
[[Attr.prototype, 'value', false], [Node.prototype, 'nodeValue', true], [Node.prototype, 'textContent', true]].forEach(function (entry) {
  var nullIsEmpty = entry[2];
  guardSetter(entry[0], entry[1], function (target, value) {
    if (nodeType(target) !== 2) return { value: value, refuse: false };
    value = value === null && nullIsEmpty ? '' : toText(value);
    return { value: value, refuse: speculative(apply(attrNameOf, target, []), value) };
  });
});
// relList belongs to its link; remember which lists those are so their token methods can be checked.
var relLists = new WeakSet(), relListGet = ownDescriptor(HTMLLinkElement.prototype, 'relList');
if (relListGet && relListGet.get) defineProperty(HTMLLinkElement.prototype, 'relList', { configurable: true, enumerable: relListGet.enumerable, set: relListGet.set, get: function () {
  var list = apply(relListGet.get, this, []); apply(weakAdd, relLists, [list]); return list;
} });
[['add', Infinity], ['toggle', 1], ['replace', 2]].forEach(function (entry) {
  var native = DOMTokenList.prototype[entry[0]], tokenCount = entry[1];
  DOMTokenList.prototype[entry[0]] = function () {
    var args = apply(copyList, arguments, []), i;
    for (i = 0; i < args.length && i < tokenCount; i++) args[i] = toText(args[i]);
    if (apply(weakHas, relLists, [this])) for (i = 0; i < args.length && i < tokenCount; i++) if (matches(SPECULATIVE_REL, args[i])) { refuse(); return false; }
    return apply(native, this, args);
  };
});
guardSetter(DOMTokenList.prototype, 'value', function (list, value) {
  value = toText(value);
  return { value: value, refuse: apply(weakHas, relLists, [list]) && matches(SPECULATIVE_REL, value) };
});

// Insertion: a frame never joins any tree, and a subtree is scrubbed before it joins the document, where a link would
// start loading at once.
function guardNodes(nodes) {
  var i, n = nodes.length;
  for (i = 0; i < n; i++) if (isFrame(nodes[i]) || queryFirst(nodes[i], FRAME_SELECTOR) !== null) throw refuseFrame();
  for (i = 0; i < n; i++) scrub(nodes[i]);
}
[[Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']],
  [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'insertAdjacentElement', 'replaceChildren', 'moveBefore']],
  [CharacterData.prototype, ['before', 'after', 'replaceWith']], [DocumentType.prototype, ['before', 'after', 'replaceWith']],
  [Document.prototype, ['append', 'prepend', 'replaceChildren', 'moveBefore']], [DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren', 'moveBefore']],
  [Range.prototype, ['insertNode', 'surroundContents']]].forEach(function (entry) {
  entry[1].forEach(function (method) {
    var native = entry[0][method];
    if (typeof native !== 'function') return;
    entry[0][method] = function () { guardNodes(arguments); return apply(native, this, arguments); };
  });
});
var body = ownDescriptor(Document.prototype, 'body');
if (body && body.set) defineProperty(Document.prototype, 'body', { configurable: true, enumerable: body.enumerable, get: body.get, set: function (value) {
  guardNodes([value]); apply(body.set, this, [value]);
} });

// Markup strings: a frame tag is refused outright, and markup that could hold a speculative link is parsed inert first.
var template = document.createElement('template'), innerHTML = ownDescriptor(Element.prototype, 'innerHTML'), SPECULATIVE_MARKUP = /<link|speculationrules/i;
function cleanMarkup(html) {
  if (matches(FRAME_MARKUP, html)) throw refuseFrame();
  if (!matches(SPECULATIVE_MARKUP, html)) return html;
  apply(innerHTML.set, template, [html]);
  scrub(apply(contentOf, template, []));
  return apply(innerHTML.get, template, []);
}
[[Element.prototype, 'innerHTML'], [Element.prototype, 'outerHTML'], [typeof ShadowRoot === 'function' ? ShadowRoot.prototype : null, 'innerHTML']].forEach(function (entry) {
  guardSetter(entry[0], entry[1], function (target, html) { return { value: cleanMarkup(html === null ? '' : toText(html)), refuse: false }; });
});
[[Element.prototype, 'insertAdjacentHTML', 1], [Element.prototype, 'setHTMLUnsafe', 0], [Element.prototype, 'setHTML', 0],
  [typeof ShadowRoot === 'function' ? ShadowRoot.prototype : null, 'setHTMLUnsafe', 0], [typeof ShadowRoot === 'function' ? ShadowRoot.prototype : null, 'setHTML', 0],
  [Document, 'parseHTMLUnsafe', 0], [Document, 'parseHTML', 0], [Document.prototype, 'execCommand', 2]].forEach(function (entry) {
  var native = entry[0] && entry[0][entry[1]], at = entry[2], command = entry[1] === 'execCommand';
  if (typeof native !== 'function') return;
  entry[0][entry[1]] = function () {
    var args = apply(copyList, arguments, []);
    if (command && args.length) args[0] = toText(args[0]);
    if (args.length > at && (!command || lowerText(args[0]) === 'inserthtml')) args[at] = cleanMarkup(toText(args[at]));
    return apply(native, this, args);
  };
});
// document.write: each call must also leave the parser between tags. A tag left open would be finished by whatever
// markup follows (the next write, or the page's own source after the script), which no check here sees: '<ifr' then
// 'ame srcdoc=...>' is an iframe, and so is '<' then 'iframe srcdoc=...>'. The probe starts with a letter, which a
// pending '<' turns into a tag name, then a comment, which survives only if the parser is between tags.
var WRITE_PROBE = 'canvas-write-end-' + Math.random().toString(36).slice(2);
var WRITE_REFUSAL = 'Agent Canvas blocked a document.write call that ends inside a tag, comment, script or style: write whole elements in each call.';
function hasComment(node, data) {
  for (var child = apply(firstChildOf, node, []); child; child = apply(nextSiblingOf, child, [])) {
    var type = apply(nodeTypeOf, child, []), inside = child;
    if (type === 8 && apply(dataOf, child, []) === data) return true;
    if (type !== 1) continue;
    if (nameOf(child) === 'template') try { inside = apply(contentOf, child, []); } catch (error) { /* not an HTML template */ }
    if (hasComment(inside, data)) return true;
  }
  return false;
}
function cleanWrite(text) {
  text = cleanMarkup(text);
  apply(innerHTML.set, template, [text + 'x<' + '!--' + WRITE_PROBE + '-->']);
  if (!hasComment(apply(contentOf, template, []), WRITE_PROBE)) { quietly(WRITE_REFUSAL); throw new Refusal(WRITE_REFUSAL); }
  return text;
}
// A frame that lands anyway is removed in its own synchronous load event, before any page listener runs. document.open
// erases window listeners, so writing and opening arm it again.
var nativeAddListener = EventTarget.prototype.addEventListener, targetOf = getter(Event.prototype, 'target'), nativeStopImmediate = Event.prototype.stopImmediatePropagation;
function loadGuard(event) {
  var target = apply(targetOf, event, []);
  if (isFrame(target)) { apply(nativeStopImmediate, event, []); removeFrame(target); }
}
function armLoadGuard() { apply(nativeAddListener, window, ['load', loadGuard, true]); }
armLoadGuard();
[[Document.prototype, 'write'], [Document.prototype, 'writeln']].forEach(function (entry) {
  var native = entry[0][entry[1]];
  if (typeof native !== 'function') return;
  entry[0][entry[1]] = function () {
    var text = '';
    for (var i = 0; i < arguments.length; i++) text += toText(arguments[i]);
    try { return apply(native, this, [cleanWrite(text)]); } finally { armLoadGuard(); }
  };
});
var nativeOpen = Document.prototype.open;
Document.prototype.open = function () {
  try { return apply(nativeOpen, this, arguments); } finally { armLoadGuard(); }
};
// Anything else (parser-inserted markup, a path not listed here) is caught as soon as it lands, in shadow roots too.
var recordType = getter(MutationRecord.prototype, 'type'), recordTarget = getter(MutationRecord.prototype, 'target'), recordAdded = getter(MutationRecord.prototype, 'addedNodes');
function backstop(node) {
  if (isFrame(node)) { removeFrame(node); return; }
  queryEach(node, FRAME_SELECTOR, removeFrame);
  scrub(node);
}
var observer = new MutationObserver(function (records) {
  for (var i = 0; i < records.length; i++) {
    try {
      var record = records[i];
      if (apply(recordType, record, []) === 'attributes') { neutralize(apply(recordTarget, record, [])); continue; }
      var added = apply(recordAdded, record, []);
      for (var j = 0, n = apply(listLength, added, []); j < n; j++) backstop(added[j]);
    } catch (error) { /* keep checking the rest */ }
  }
});
var OBSERVED = Object.create(null), nativeObserve = MutationObserver.prototype.observe, nativeAttachShadow = Element.prototype.attachShadow;
OBSERVED.subtree = true; OBSERVED.childList = true; OBSERVED.attributes = true; OBSERVED.attributeFilter = ['rel', 'type'];
apply(nativeObserve, observer, [document, OBSERVED]);
if (typeof nativeAttachShadow === 'function') Element.prototype.attachShadow = function () {
  var root = apply(nativeAttachShadow, this, arguments);
  try { apply(nativeObserve, observer, [root, OBSERVED]); } catch (error) { /* only the backstop misses this root */ }
  return root;
};

var pending = {}, counter = 0;
var GESTURE_SEND = 'canvas.send works only from a click or key press in the page, not on load or from a timer, so nothing reaches the conversation without the user.';
function sendFailure(message) {
  var error = new Error(message);
  error.name = 'CanvasSendError';
  error.canvasSend = true;
  return error;
}
function send(action, data) {
  return new Promise(function (resolve, reject) {
    if (typeof action !== 'string' || !action.trim()) throw sendFailure('canvas.send(action, data) needs an action label, such as canvas.send("Approve plan", { plan: "B" }).');
    action = action.trim();
    if (action.length > LIMITS.action) throw sendFailure('The action label is ' + action.length + ' characters; the limit is ' + LIMITS.action + '. Put the details in data.');
    var text;
    try { text = toJson(data, 'canvas.send data'); } catch (error) { throw sendFailure(error.message); }
    if (text.length > LIMITS.dataBytes) throw sendFailure('canvas.send data is ' + text.length + ' characters as JSON; the limit is ' + LIMITS.dataBytes + '. Send a summary or the user\'s choices, not the whole dataset.');
    // The host checks this again in its own window, where the page cannot fake it.
    if (!userActive()) throw sendFailure(GESTURE_SEND);
    var id = 'send-' + (++counter) + '-' + Date.now().toString(36);
    var timer = setTimeout(function () {
      delete pending[id];
      reject(sendFailure('Agent Canvas did not confirm this input within a minute, so it may not have been sent. Check the list of inputs sent to your agent.'));
    }, 60000);
    pending[id] = { resolve: resolve, reject: reject, timer: timer };
    post('send', { id: id, action: action, data: JSON.parse(text) });
  });
}

var pageState = null, formDrafts = {};
(function restoreDraft(initial) {
  if (initial && typeof initial === 'object' && initial.canvasDraft === 1) {
    pageState = initial.page === undefined ? null : initial.page;
    if (initial.forms && typeof initial.forms === 'object') formDrafts = initial.forms;
  } else if (initial !== undefined) pageState = initial;
})(config.state);
var draftText = JSON.stringify({ canvasDraft: 1, page: pageState, forms: formDrafts });
function saveDraft() {
  var text = JSON.stringify({ canvasDraft: 1, page: pageState, forms: formDrafts });
  if (text === draftText) return 0;
  if (text.length > LIMITS.draftBytes) return text.length;
  draftText = text;
  post('state', { state: JSON.parse(text) });
  return 0;
}
var state = Object.freeze({
  get: function () { return pageState === null ? null : JSON.parse(JSON.stringify(pageState)); },
  set: function (value) {
    var previous = pageState;
    pageState = JSON.parse(toJson(value, 'canvas.state.set(value)'));
    var size = saveDraft();
    if (size) {
      pageState = previous;
      throw new RangeError('canvas.state.set: the draft would be ' + size + ' characters; the limit is ' + LIMITS.draftBytes + '. Keep only what is needed to restore the page.');
    }
  }
});

var theme = { appearance: config.appearance, variables: config.variables }, themeListeners = [];
function themeCopy() {
  var variables = {};
  for (var key in theme.variables) variables[key] = theme.variables[key];
  return { appearance: theme.appearance, variables: variables };
}
function themeCss(next) {
  var rules = [];
  for (var key in next.variables) if (/^--[A-Za-z0-9-]+$/.test(key)) rules.push(key + ':' + String(next.variables[key]).replace(/[<>{};]/g, ''));
  rules.push('color-scheme:' + next.appearance);
  return ':root{' + rules.join(';') + '}';
}
function applyTheme(next) {
  if ((next.appearance !== 'light' && next.appearance !== 'dark') || !next.variables || typeof next.variables !== 'object') return;
  if (next.appearance === theme.appearance && JSON.stringify(next.variables) === JSON.stringify(theme.variables)) return;
  theme = { appearance: next.appearance, variables: next.variables };
  if (themeStyle) themeStyle.textContent = themeCss(theme);
  root.setAttribute('data-theme', theme.appearance);
  themeListeners.slice().forEach(function (listener) {
    try { listener(themeCopy()); } catch (error) { reportError(error); }
  });
}
root.setAttribute('data-theme', theme.appearance);

var lastGesture = 0;
['pointerdown', 'keydown', 'click'].forEach(function (type) {
  window.addEventListener(type, function (event) { if (event.isTrusted) lastGesture = Date.now(); }, true);
});
function userActive() {
  return navigator.userActivation ? navigator.userActivation.isActive : Date.now() - lastGesture < 1000;
}
function openLink(url) {
  var parsed = new URL(String(url));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('canvas.openLink only opens http(s) links, not ' + parsed.protocol);
  // Nothing may open windows or take focus on its own: only a click or key press in the page opens a link.
  if (!userActive()) throw new Error('Links open only from a click or key press, not on load or from a timer: ' + parsed.href);
  post('link', { url: parsed.href });
}
window.open = function (url) {
  var text = url === undefined || url === null ? '' : String(url);
  if (/^\s*https?:\/\//i.test(text)) { try { openLink(text.trim()); } catch (error) { reportError(error); } }
  return null;
};

var api = Object.freeze({
  send: send,
  state: state,
  view: Object.freeze({ id: config.view.id, revision: config.view.revision, title: config.view.title }),
  get theme() { return themeCopy(); },
  onTheme: function (listener) {
    if (typeof listener !== 'function') throw new TypeError('canvas.onTheme(listener) needs a function.');
    themeListeners.push(listener);
    return function () { var i = themeListeners.indexOf(listener); if (i >= 0) themeListeners.splice(i, 1); };
  },
  openLink: openLink
});
window.canvas = api;
window.agentCanvas = api;

['localStorage', 'sessionStorage'].forEach(function (name) {
  try { if (window[name]) return; } catch (error) { /* sandboxed: fall through to a memory store */ }
  var items = Object.create(null);
  var store = {
    getItem: function (key) { key = String(key); return key in items ? items[key] : null; },
    setItem: function (key, value) { items[String(key)] = String(value); },
    removeItem: function (key) { delete items[String(key)]; },
    clear: function () { items = Object.create(null); },
    key: function (index) { var keys = Object.keys(items); return index < keys.length ? keys[index] : null; },
    get length() { return Object.keys(items).length; }
  };
  try { Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return store; } }); } catch (error) { /* keep the native accessor */ }
});

function element(node) { while (node && node.nodeType !== 1) node = node.parentNode; return node; }
function isSubmitter(el) {
  if (!el || !el.form) return false;
  if (el.tagName === 'BUTTON') return el.type === 'submit';
  return el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image');
}
function track(el, promise) {
  el.setAttribute('data-canvas-state', 'sending');
  el.setAttribute('aria-busy', 'true');
  function settle(ok, error) {
    el.removeAttribute('aria-busy');
    el.setAttribute('data-canvas-state', ok ? 'sent' : 'failed');
    if (ok) el.removeAttribute('data-canvas-error'); else el.setAttribute('data-canvas-error', error && error.message ? error.message : String(error));
    el.dispatchEvent(new CustomEvent('canvas:result', { bubbles: true, detail: ok ? { ok: true } : { ok: false, error: error && error.message ? error.message : String(error) } }));
  }
  promise.then(function () { settle(true); }, function (error) { settle(false, error); });
}
function busy(el) { return el.getAttribute('data-canvas-state') === 'sending'; }

function sendFromElement(el) {
  if (busy(el)) return;
  var action = (el.getAttribute('data-canvas-action') || '').trim() || (el.textContent || '').trim().slice(0, LIMITS.action) || 'Click';
  var raw = el.getAttribute('data-canvas-data'), data = null;
  if (raw !== null && raw.trim()) {
    try { data = JSON.parse(raw); }
    catch (error) {
      report('data-canvas-data on "' + action + '" is not valid JSON (' + error.message + '). Use single quotes around the attribute and double quotes inside, e.g. data-canvas-data=\'{"plan":"B"}\'.');
      el.setAttribute('data-canvas-state', 'failed');
      return;
    }
  }
  track(el, send(action, data));
}

function formValues(form, submitter) {
  var entries;
  try { entries = new FormData(form, submitter || undefined); }
  catch (error) { entries = new FormData(form); if (submitter && submitter.name) entries.append(submitter.name, submitter.value); }
  var out = {}, special = {};
  entries.forEach(function (value, key) {
    if (typeof value !== 'string') value = value && value.name ? { name: value.name, type: value.type, size: value.size } : null;
    if (hasOwn.call(out, key)) out[key] = [].concat(out[key], [value]); else out[key] = value;
  });
  each.call(form.elements, function (el) {
    var type = (el.type || '').toLowerCase();
    if (!el.name || el.matches(':disabled') || !/^(checkbox|radio|select-multiple|number|range)$/.test(type)) return;
    (special[el.name] = special[el.name] || []).push(el);
  });
  Object.keys(special).forEach(function (name) {
    var els = special[name], type = els[0].type.toLowerCase();
    if (!els.every(function (el) { return el.type.toLowerCase() === type; })) return;
    if (type === 'checkbox') {
      out[name] = els.length === 1 ? els[0].checked : els.filter(function (el) { return el.checked; }).map(function (el) { return el.value; });
    } else if (type === 'radio') {
      var picked = els.filter(function (el) { return el.checked; })[0];
      out[name] = picked ? picked.value : null;
    } else if (type === 'select-multiple' && els.length === 1) {
      out[name] = Array.prototype.filter.call(els[0].options, function (o) { return o.selected; }).map(function (o) { return o.value; });
    } else if ((type === 'number' || type === 'range') && els.length === 1) {
      var value = els[0].value;
      out[name] = value === '' ? null : isNaN(Number(value)) ? value : Number(value);
    }
  });
  return out;
}

function submitForm(form, submitter) {
  if (busy(form)) return;
  var noValidate = form.noValidate || (submitter && submitter.formNoValidate);
  if (!noValidate && !form.reportValidity()) return;
  var event;
  try { event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null }); }
  catch (error) { event = new Event('submit', { bubbles: true, cancelable: true }); }
  if (!form.dispatchEvent(event)) return;
  var action = form.getAttribute('data-canvas-action');
  if (action === null) return;
  track(form, send(action.trim() || 'Submit', formValues(form, submitter)));
}
var formProto = HTMLFormElement.prototype;
formProto.requestSubmit = function (submitter) { submitForm(this, submitter || null); };
formProto.submit = function () {
  var action = this.getAttribute('data-canvas-action');
  if (action !== null && !busy(this)) track(this, send(action.trim() || 'Submit', formValues(this, null)));
};

var CLICK_TARGET = '[data-canvas-action]:not(form), a[href], area[href], button, input, select, textarea, label, summary';
window.addEventListener('click', function (event) {
  if (event.defaultPrevented || event.button !== 0) return;
  var start = element(event.target), hit = start && start.closest ? start.closest(CLICK_TARGET) : null;
  if (!hit) return;
  if (hit.hasAttribute('data-canvas-action')) {
    if (!/^(checkbox|radio)$/.test(hit.tagName === 'INPUT' ? hit.type : '')) event.preventDefault();
    sendFromElement(hit);
    return;
  }
  if (isSubmitter(hit)) { event.preventDefault(); submitForm(hit.form, hit); return; }
  if (hit.tagName === 'A' || hit.tagName === 'AREA' || hit.tagName.toLowerCase() === 'a') followLink(event, hit);
});
function followLink(event, link) {
  var raw = (link.getAttribute('href') || link.getAttribute('xlink:href') || '').trim();
  if (/^javascript:/i.test(raw)) return;
  event.preventDefault();
  if (raw.charAt(0) === '#') {
    var id = raw.slice(1);
    try { id = decodeURIComponent(id); } catch (error) { /* use the raw fragment */ }
    var target = id && (document.getElementById(id) || document.getElementsByName(id)[0]);
    if (target) target.scrollIntoView({ block: 'start' }); else if (id === 'top') window.scrollTo(0, 0);
    return;
  }
  if (/^https?:\/\//i.test(raw)) { try { openLink(raw); } catch (error) { reportError(error); } }
}

var IMPLICIT = /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/;
window.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  var input = event.target;
  if (!input || input.tagName !== 'INPUT' || !input.form || !IMPLICIT.test((input.type || 'text').toLowerCase())) return;
  event.preventDefault();
  var form = input.form, fallback = null, fields = 0;
  each.call(form.elements, function (el) {
    if (!fallback && isSubmitter(el)) fallback = el;
    if (el.tagName === 'INPUT' && IMPLICIT.test((el.type || 'text').toLowerCase())) fields++;
  });
  if (fallback) {
    if (fallback.disabled) return;
    if (fallback.hasAttribute('data-canvas-action')) sendFromElement(fallback); else submitForm(form, fallback);
  } else if (fields === 1) submitForm(form, null);
});

var DRAFT_SKIP = /^(submit|button|reset|image|file|password|hidden)$/;
function draftForms() {
  return Array.prototype.filter.call(document.forms, function (form) {
    var mode = form.getAttribute('data-canvas-draft');
    return mode !== 'off' && (mode !== null || form.hasAttribute('data-canvas-action'));
  });
}
function draftKey(form, index) { return form.id || form.getAttribute('name') || 'form-' + index; }
function eachField(form, visit) {
  var seen = {};
  each.call(form.elements, function (el) {
    var type = (el.type || '').toLowerCase();
    if (!el.name || DRAFT_SKIP.test(type) || el.getAttribute('data-canvas-draft') === 'off') return;
    seen[el.name] = (seen[el.name] || 0) + 1;
    visit(el, type, el.name + '|' + seen[el.name]);
  });
}
function readForm(form) {
  var values = {};
  eachField(form, function (el, type, key) {
    if (type === 'checkbox' || type === 'radio') values[key] = el.checked;
    else if (type === 'select-multiple') values[key] = Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
    else values[key] = el.value;
  });
  return values;
}
function restoreForm(form, saved) {
  var restored = false;
  eachField(form, function (el, type, key) {
    if (!hasOwn.call(saved, key)) return;
    var value = saved[key];
    if (type === 'checkbox' || type === 'radio') el.checked = !!value;
    else if (type === 'select-multiple' && Array.isArray(value)) each.call(el.options, function (o) { o.selected = value.indexOf(o.value) >= 0; });
    else if (typeof value === 'string') el.value = value;
    else return;
    restored = true;
  });
  if (restored) form.dispatchEvent(new CustomEvent('canvas:restored', { bubbles: true }));
}
// Saved at once (coalesced per task, so input and change make one post): the host stores it on its own schedule and
// flushes when the app is hidden, but a message still waiting in this frame would be lost to a reload.
var draftQueued = false, draftWarned = false;
function scheduleFormDraft() {
  if (draftQueued) return;
  draftQueued = true;
  Promise.resolve().then(function () {
    draftQueued = false;
    var next = {};
    draftForms().forEach(function (form, index) { next[draftKey(form, index)] = readForm(form); });
    var previous = formDrafts;
    formDrafts = next;
    if (saveDraft()) {
      formDrafts = previous;
      if (!draftWarned) { draftWarned = true; report('The form draft is larger than ' + LIMITS.draftBytes + ' characters, so it is not saved. Mark large fields with data-canvas-draft="off".'); }
    }
  });
}
function draftEvent(event) {
  var el = element(event.target), form = el && (el.form || (el.closest && el.closest('form')));
  if (form && draftForms().indexOf(form) >= 0) scheduleFormDraft();
}
document.addEventListener('input', draftEvent, true);
document.addEventListener('change', draftEvent, true);
document.addEventListener('reset', draftEvent, true);

var lastHeight = -1;
function measure() {
  var body = document.body, height = root.getBoundingClientRect().height;
  if (body) height = Math.max(height, body.scrollHeight);
  var scroller = document.scrollingElement || root;
  if (scroller.scrollHeight > window.innerHeight + 1) height = Math.max(height, scroller.scrollHeight);
  height = Math.ceil(height);
  if (height !== lastHeight) { lastHeight = height; post('size', { height: height }); }
}
var resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
if (resizeObserver) resizeObserver.observe(root);
document.addEventListener('DOMContentLoaded', function () {
  draftForms().forEach(function (form, index) {
    var saved = formDrafts[draftKey(form, index)];
    if (saved && typeof saved === 'object') restoreForm(form, saved);
  });
  if (resizeObserver && document.body) resizeObserver.observe(document.body);
  measure();
});
window.addEventListener('load', measure);

window.addEventListener('message', function (event) {
  if (event.source !== host) return;
  var message = event.data;
  if (!message || message.channel !== CHANNEL || message.v !== 1) return;
  if (message.type === 'ack' && typeof message.id === 'string' && hasOwn.call(pending, message.id)) {
    var entry = pending[message.id];
    delete pending[message.id];
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(); else entry.reject(sendFailure(typeof message.error === 'string' && message.error ? message.error : 'Agent Canvas could not send this input.'));
  } else if (message.type === 'theme') applyTheme(message);
});
post('ready');
`;

/** The bridge as one script body; `configJson` must already be safe inside a <script> element. */
export function bridgeScript(configJson: string): string {
  return `(function(config){${BRIDGE_SOURCE}})(${configJson});`;
}
