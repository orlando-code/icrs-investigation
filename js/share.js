import QRCode from "https://esm.sh/qrcode@1.5.4";

const CANONICAL_URL = "https://orlando-code.github.io/icrs-investigation/";

export function createShareView(siteData, elements) {
  const title = siteData.meta.title;
  const summary =
    "Affiliation map and co-authorship network for ICRS 2026 speakers, centred on Auckland.";

  function shareUrl() {
    if (location.hostname.endsWith("github.io")) {
      return CANONICAL_URL;
    }
    return location.href.split("#")[0];
  }

  function setStatus(message, isError = false) {
    if (!elements.status) return;
    elements.status.textContent = message || "";
    elements.status.classList.toggle("error", isError);
  }

  async function renderQr() {
    const url = shareUrl();
    if (elements.url) elements.url.textContent = url;
    if (elements.urlInput) elements.urlInput.value = url;
    if (!elements.qrCanvas) return;

    const size = Math.min(280, Math.max(200, window.innerWidth - 56));
    elements.qrCanvas.width = size;
    elements.qrCanvas.height = size;

    await QRCode.toCanvas(elements.qrCanvas, url, {
      width: size,
      margin: 2,
      color: {
        dark: "#14212b",
        light: "#ffffff",
      },
    });
  }

  async function copyLink() {
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Link copied to clipboard.");
      return true;
    } catch {
      if (elements.urlInput) {
        elements.urlInput.select();
        document.execCommand("copy");
        setStatus("Link copied to clipboard.");
        return true;
      }
      setStatus("Could not copy link.", true);
      return false;
    }
  }

  async function pushShare() {
    const url = shareUrl();
    const shareData = {
      title,
      text: summary,
      url,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        setStatus("Shared.");
        return true;
      } catch (error) {
        if (error?.name === "AbortError") return false;
        setStatus("Share failed — try copy link instead.", true);
        return false;
      }
    }

    return copyLink();
  }

  function bindEvents() {
    elements.copyBtn?.addEventListener("click", () => {
      copyLink();
    });
    elements.pushBtn?.addEventListener("click", () => {
      pushShare();
    });
    elements.urlInput?.addEventListener("focus", (event) => {
      event.target.select();
    });
  }

  bindEvents();

  if (!navigator.share && elements.pushBtn) {
    elements.pushBtn.textContent = "Copy link to share";
  }

  return {
    render: renderQr,
    copyLink,
    pushShare,
    shareUrl,
  };
}
