import { Workbox } from "workbox-window";

if ("serviceWorker" in navigator) {
  const wb = new Workbox("service-worker.js");

  wb.addEventListener("waiting", (event) => {
    if (confirm("A new version is available. Update now?")) {
      wb.messageSkipWaiting();
    }
  });

  wb.addEventListener("controlling", () => {
    window.location.reload();
  });

  wb.register();
}
