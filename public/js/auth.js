const message = document.getElementById('loginMessage');
const target = new URLSearchParams(location.search).get('next') || '/';

function showMessage(text, isError = false){
  if(!message) return;
  message.textContent = text;
  message.classList.toggle('error', isError);
}

async function postCredential(response){
  showMessage('Validando login...');
  const res = await fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: response.credential })
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || !data.ok){
    showMessage(data.message || 'Falha ao autenticar com Google.', true);
    return;
  }
  location.href = target;
}

async function boot(){
  try{
    const configRes = await fetch('/api/auth/config');
    const config = await configRes.json();
    if(!config.googleClientId){
      showMessage('GOOGLE_CLIENT_ID nao configurado no deploy.', true);
      return;
    }
    const waitForGoogle = () => new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if(window.google?.accounts?.id){
          clearInterval(timer);
          resolve();
        }else if(Date.now() - started > 10000){
          clearInterval(timer);
          reject(new Error('SDK do Google nao carregou.'));
        }
      }, 100);
    });
    await waitForGoogle();
    window.google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: postCredential,
      use_fedcm_for_prompt: true
    });
    window.google.accounts.id.renderButton(
      document.getElementById('googleSignIn'),
      { theme: 'filled_blue', size: 'large', type: 'standard', shape: 'rectangular', text: 'signin_with', width: 280 }
    );
  }catch(error){
    showMessage(error.message || 'Falha ao carregar login.', true);
  }
}

boot();
