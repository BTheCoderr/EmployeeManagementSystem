'use strict';

document.querySelectorAll('[data-demo-email]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelector('input[name="email"]').value = button.dataset.demoEmail;
    document.querySelector('input[name="password"]').value = button.dataset.demoPassword;
    document.querySelector('input[name="password"]').focus();
  });
});
