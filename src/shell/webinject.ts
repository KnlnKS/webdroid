// Runs before any script of a document a WebView frame loads. The dev server injects it into
// proxied and asset HTML, srcdoc documents prepend it: the JavaScript interfaces a WebView
// declares are parked on its <iframe> element, which a same-origin child reaches as frameElement.
export const WEB_INJECT = "<script>(function(){var f=window.frameElement;if(f&&f.__wdIfaces)Object.assign(window,f.__wdIfaces)})()</script>";
