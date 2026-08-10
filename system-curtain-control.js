(() => {
  "use strict";

  const token = (() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    try { return decodeURIComponent(parts.at(-1) || ""); } catch { return ""; }
  })();
  const stateCard = document.getElementById("stateCard");
  const stateText = document.getElementById("stateText");
  const feedback = document.getElementById("feedback");
  const closeButton = document.getElementById("closeSystemButton");
  const openButton = document.getElementById("openSystemButton");
  let busy = false;

  function setBusy(nextBusy) {
    busy = nextBusy;
    closeButton.disabled = busy;
    openButton.disabled = busy;
  }

  function renderState(active) {
    stateCard.dataset.state = active ? "closed" : "open";
    stateText.textContent = active ? "Perde indirildi · paneller erişime kapalı" : "Perde kaldırıldı · paneller normal çalışıyor";
  }

  function showFeedback(message, isError = false) {
    feedback.textContent = message;
    feedback.classList.toggle("is-error", isError);
  }

  async function readState() {
    try {
      const response = await fetch(`/api/system-curtain/status?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Durum alınamadı.");
      const payload = await response.json();
      renderState(payload.active === true);
    } catch (error) {
      stateCard.dataset.state = "loading";
      stateText.textContent = "Durum alınamadı";
      showFeedback(error.message || "Bağlantı hatası oluştu.", true);
    }
  }

  async function changeState(active) {
    if (busy) return;
    const actionLabel = active ? "Perdeyi indirmek" : "Perdeyi kaldırmak";
    if (!window.confirm(`${actionLabel} istediğinize emin misiniz?`)) return;
    setBusy(true);
    showFeedback("İşlem uygulanıyor…");
    try {
      const response = await fetch("/api/system-curtain/control", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Delivera-Curtain-Control": token,
        },
        body: JSON.stringify({ active }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Kontrol işlemi tamamlanamadı.");
      renderState(payload.active === true);
      showFeedback(active ? "Perde bütün panellere indirildi." : "Perde bütün panellerden kaldırıldı.");
    } catch (error) {
      showFeedback(error.message || "Bağlantı hatası oluştu.", true);
    } finally {
      setBusy(false);
    }
  }

  closeButton.addEventListener("click", () => changeState(true));
  openButton.addEventListener("click", () => changeState(false));
  readState();
})();
