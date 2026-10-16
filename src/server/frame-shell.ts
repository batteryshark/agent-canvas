// The browser surface's HTML frame. The service serves FRAME_SHELL_HTML at GET /frame with FRAME_CSP;
// the parent posts the built page and the shell writes it into itself, so the CSP stays in force.

/** Served as the Content-Security-Policy header of GET /frame. No network anywhere, like the OpenChamber pane. */
export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

// The same policy as a meta tag guards the shell even if a proxy drops the header (frame-ancestors only works as a header).
const META_CSP = FRAME_CSP.split('; ').filter(d => !d.startsWith('frame-ancestors')).join('; ');

// The script is an IIFE because document.open() keeps this window's globals: the page must not inherit any.
export const FRAME_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${META_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas page</title></head><body><script>(function(){var done=false;function render(event){if(done||event.source!==window.parent)return;var m=event.data;if(!m||m.channel!=='agent-canvas'||m.v!==1||m.type!=='render'||typeof m.html!=='string')return;done=true;window.removeEventListener('message',render);document.open();document.write(m.html);document.close();}window.addEventListener('message',render);window.parent.postMessage({channel:'agent-canvas',v:1,type:'ready',shell:true},'*');})();</script></body></html>`;
