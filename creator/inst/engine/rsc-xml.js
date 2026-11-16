/* ---------------------------------------------------------------------------
 * rsc-xml.js -- a small XML reader / writer for Rocksmith documents
 * (arrangements, vocals, showlights, game xblocks). No DOMParser: the same code
 * runs in browsers, workers and Node.
 *
 *   const doc = RSCreator.engine.xmlParse(text)  // {name, attrs, children, text}
 *   RSCreator.engine.xmlSerialize(doc, {comment})
 *   node helpers: xmlChild(node, name), xmlChildren(node, name), xmlText(node, name)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;

  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function decode(s) {
    if (s.indexOf("&") < 0) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e] != null ? ENT[e] : m;
    });
  }
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** Parse XML text (or UTF-8 bytes) into {name, attrs, children, text}; comments are
   *  kept as {comment} children of the element they appear in (the root's ones too). */
  E.xmlParse = function (input) {
    let s = typeof input === "string" ? input : E.fromUtf8(input);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const n = s.length;
    let i = 0;
    const top = { name: "#document", attrs: {}, children: [], text: "" };
    const stack = [top];
    while (i < n) {
      const lt = s.indexOf("<", i);
      const cur = stack[stack.length - 1];
      if (lt < 0) { if (stack.length > 1) cur.text += decode(s.slice(i)); break; }
      if (lt > i && stack.length > 1) {
        const t = s.slice(i, lt);
        if (cur.text || /\S/.test(t)) cur.text += decode(t);
      }
      const c = s.charCodeAt(lt + 1);
      if (c === 63 /* ? */) { const e = s.indexOf("?>", lt); i = e < 0 ? n : e + 2; continue; }
      if (c === 33 /* ! */) {
        if (s.startsWith("<!--", lt)) {
          const e = s.indexOf("-->", lt + 4);
          cur.children.push({ comment: s.slice(lt + 4, e < 0 ? n : e) });
          i = e < 0 ? n : e + 3; continue;
        }
        if (s.startsWith("<![CDATA[", lt)) {
          const e = s.indexOf("]]>", lt);
          cur.text += s.slice(lt + 9, e < 0 ? n : e);
          i = e < 0 ? n : e + 3; continue;
        }
        const e = s.indexOf(">", lt); i = e < 0 ? n : e + 1; continue;   // DOCTYPE
      }
      if (c === 47 /* / */) {
        const e = s.indexOf(">", lt);
        const name = s.slice(lt + 2, e).trim();
        if (stack.length > 1 && stack[stack.length - 1].name === name) {
          const done = stack.pop();
          if (!done.children.some((ch) => !ch.comment)) done.text = done.text.trim() === "" ? done.text.trim() : done.text;
        }
        i = e + 1; continue;
      }
      // start tag
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(s[j])) j++;
      const node = { name: s.slice(lt + 1, j), attrs: {}, children: [], text: "" };
      for (;;) {
        while (j < n && /\s/.test(s[j])) j++;
        if (s[j] === "/" || s[j] === ">") break;
        let k = j;
        while (k < n && s[k] !== "=" && !/[\s/>]/.test(s[k])) k++;
        const an = s.slice(j, k);
        while (k < n && /\s/.test(s[k])) k++;
        if (s[k] !== "=") { node.attrs[an] = ""; j = k; continue; }
        k++;
        while (k < n && /\s/.test(s[k])) k++;
        const q = s[k];
        const e = s.indexOf(q, k + 1);
        node.attrs[an] = decode(s.slice(k + 1, e));
        j = e + 1;
      }
      cur.children.push(node);
      if (s[j] === "/") { i = s.indexOf(">", j) + 1; } else { stack.push(node); i = j + 1; }
    }
    const rootEl = top.children.find((ch) => !ch.comment);
    if (!rootEl) throw new Error("Empty XML document.");
    rootEl.leading = top.children.filter((ch) => ch.comment).map((ch) => ch.comment);
    return rootEl;
  };

  E.xmlChild = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null);
  E.xmlChildren = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
  E.xmlText = (node, name, dflt) => { const c = E.xmlChild(node, name); return c ? c.text : dflt; };

  /** Element builder: el("note", {time: "1.000"}, [children], "text") */
  E.el = (name, attrs, children, text) => ({ name, attrs: attrs || {}, children: children || [], text: text == null ? "" : String(text) });

  /**
   * Serialise like the Custom Song Toolkit: UTF-8 declaration, 2-space indent,
   * `<x a="1" />` for empty elements, text-only elements on one line.
   * opts.comments: comment lines placed first inside the root element.
   */
  E.xmlSerialize = function (rootEl, opts) {
    opts = opts || {};
    const out = ['<?xml version="1.0" encoding="utf-8"?>'];
    function open(node) {
      let s = "<" + node.name;
      for (const k in node.attrs) { const v = node.attrs[k]; if (v !== undefined && v !== null) s += " " + k + '="' + escAttr(v) + '"'; }
      return s;
    }
    function walk(node, ind, first) {
      if (node.comment != null) { out.push(ind + "<!--" + node.comment + "-->"); return; }
      const kids = node.children || [];
      if (!kids.length) {
        if (node.text !== "" && node.text != null) out.push(ind + open(node) + ">" + escText(node.text) + "</" + node.name + ">");
        else if (node.keepOpen) out.push(ind + open(node) + "></" + node.name + ">");
        else out.push(ind + open(node) + " />");
        return;
      }
      out.push(ind + open(node) + ">");
      if (first) for (const c of opts.comments || []) out.push(ind + "  <!--" + c + "-->");
      for (const k of kids) walk(k, ind + "  ", false);
      out.push(ind + "</" + node.name + ">");
    }
    walk(rootEl, "", true);
    return out.join("\n") + "\n";
  };
})(typeof window !== "undefined" ? window : globalThis);
