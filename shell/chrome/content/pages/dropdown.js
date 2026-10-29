// In-page dropdown for Seijaku's chrome pages.
//
// WHY THIS EXISTS: every Seijaku page (settings, bookmarks, pdf) is a
// chrome-privileged document (the seijaku: protocol maps to
// chrome://seijaku/content/pages/*.html), hosted in a shell window whose
// document root is plain HTML with grafted XUL — not a XUL <window>.
// A native <select>'s dropdown popup is content-docshell machinery that
// has no proper widget-parent chain in that host, so the list never
// opens on the released Windows build (all six settings selects fail
// uniformly, while inputs, checkboxes and buttons work fine; nothing in
// settings.js or the CSS disables them). Firefox's own chrome UI uses
// XUL <menulist> for exactly this reason; this shell has no XUL window
// to host one, so the pages get this lightweight stand-in instead.
//
// DESIGN: the native <select> stays in the DOM as the value holder
// (hidden, tabindex -1). A button next to it shows the current option
// and an in-flow list under it shows the options — in-flow, not a
// popup, so nothing can clip it or need a popupset. Picking an option
// sets select.value and dispatches a bubbling "change", so every
// existing binding (settings.js bind()/bindBool(), bookmarks.js
// folder-filter and move selects, pdf.js width) works unchanged.
// A MutationObserver rebuilds the list when options change (the
// bookmarks page rebuilds its folder-filter options on every render).
//
// Usage: include this script AFTER the page's own script, and call
// window.SeijakuDropdown?.enhanceAll() after any render that replaces
// selects (bookmarks.js does). Pages that never replace selects only
// need the script tag — enhancement runs on DOMContentLoaded.

"use strict";

window.SeijakuDropdown = (() => {
  function currentLabel(select) {
    let opt = select.selectedOptions?.[0] || select.options[select.selectedIndex];
    return opt ? opt.textContent : "—";
  }

  function enhance(select) {
    if (select.dataset.ddEnhanced) return;
    select.dataset.ddEnhanced = "1";

    let wrap = document.createElement("div");
    wrap.className = "dd-wrap";
    let btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    if (select.title) btn.title = select.title;
    if (select.disabled) btn.disabled = true;
    let list = document.createElement("div");
    list.className = "dd-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    wrap.append(btn, list);
    select.after(wrap);

    // Hide the native control only now that its replacement exists.
    select.style.display = "none";
    select.tabIndex = -1;

    let highlight = -1;

    function build() {
      list.replaceChildren();
      for (let opt of select.options) {
        let item = document.createElement("div");
        item.className = "dd-option";
        item.setAttribute("role", "option");
        item.textContent = opt.textContent;
        item.dataset.value = opt.value;
        item.addEventListener("click", () => pick(opt.value));
        list.append(item);
      }
      sync();
    }

    function sync() {
      btn.textContent = currentLabel(select) + " ▾";
      for (let item of list.children) {
        let on = item.dataset.value == select.value;
        item.setAttribute("aria-selected", on ? "true" : "false");
        item.classList.toggle("dd-highlight", on && !list.hidden && highlight < 0);
      }
    }

    function setHighlight(i) {
      let items = [...list.children];
      if (!items.length) return;
      highlight = (i + items.length) % items.length;
      for (let [j, item] of items.entries()) {
        item.classList.toggle("dd-highlight", j == highlight);
      }
      items[highlight].scrollIntoView({ block: "nearest" });
    }

    function open() {
      build();
      list.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      let idx = [...select.options].findIndex(o => o.value == select.value);
      highlight = -1;
      setHighlight(idx < 0 ? 0 : idx);
    }

    function close() {
      list.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      highlight = -1;
    }

    function pick(value) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      close();
      btn.focus();
    }

    btn.addEventListener("click", () => {
      if (list.hidden) open();
      else close();
    });

    btn.addEventListener("keydown", e => {
      if (e.key == "Enter" || e.key == " ") {
        e.preventDefault();
        if (list.hidden) open();
        else if (highlight >= 0) pick([...list.children][highlight].dataset.value);
        else close();
      } else if (e.key == "ArrowDown") {
        e.preventDefault();
        if (list.hidden) open();
        else setHighlight(highlight + 1);
      } else if (e.key == "ArrowUp") {
        e.preventDefault();
        if (list.hidden) open();
        else setHighlight(highlight - 1);
      } else if (e.key == "Escape" && !list.hidden) {
        e.preventDefault();
        close();
      }
    });

    // Clicking anywhere outside the button/list closes it. The button's
    // own click is inside the wrap, so it never reaches this branch.
    document.addEventListener("click", e => {
      if (!wrap.contains(e.target)) close();
    });

    // Tabbing away closes it too. The timeout lets a click on an option
    // land first (mousedown fires before blur, click after).
    btn.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement !== btn) close();
      }, 0);
    });

    // Programmatic value sets that fire change (and the component's own
    // picks) re-sync the label; option rebuilds re-render the list.
    select.addEventListener("change", sync);
    new MutationObserver(() => build()).observe(select, { childList: true });

    build();
  }

  function enhanceAll(root = document) {
    for (let select of root.querySelectorAll("select:not([data-dd-enhanced])")) {
      try {
        enhance(select);
      } catch (e) {
        // A broken enhancement must never take the page's own controls
        // down with it — the native select is still in the DOM.
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => enhanceAll());

  return { enhanceAll };
})();
