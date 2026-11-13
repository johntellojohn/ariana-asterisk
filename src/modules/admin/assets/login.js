(function () {
  const form = document.getElementById("login-form");
  const errorBox = document.getElementById("login-error");
  const submitBtn = document.getElementById("login-submit");

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.classList.add("hidden");
    submitBtn.disabled = true;

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    try {
      const response = await fetch("/admin/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        errorBox.textContent = data.message || "Error de autenticación.";
        errorBox.classList.remove("hidden");
        return;
      }

      window.location.href = "/admin";
    } catch (_err) {
      errorBox.textContent = "No se pudo conectar con el servidor local.";
      errorBox.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
    }
  });
})();

