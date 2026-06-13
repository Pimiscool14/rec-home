// Rec Home - Client-side JavaScript
// Auto-hide flash messages
document.addEventListener('DOMContentLoaded', () => {
  const flashes = document.querySelectorAll('.flash');
  flashes.forEach(flash => {
    setTimeout(() => {
      flash.style.opacity = '0';
      flash.style.transition = 'opacity 0.3s';
      setTimeout(() => flash.remove(), 300);
    }, 5000);
  });
});

// Color picker sync
const colorInput = document.getElementById('esp_color');
const colorValue = document.querySelector('.color-value');
if (colorInput && colorValue) {
  colorInput.addEventListener('input', () => {
    colorValue.textContent = colorInput.value;
  });
}
