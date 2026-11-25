/* Адреса бази Supabase і її публічний ключ.

   Публічний ключ (publishable) призначений саме для браузера: що кому
   видно, вирішують правила в самій базі (кожен бачить лише свої рядки)
   і вхід за паролем. Ключ service_role / secret сюди вписувати не можна. */
window.SPRAVY_CONFIG = {
  url: 'https://erhtylomzzqojqarilje.supabase.co',
  anonKey: 'sb_publishable_wDD3kFdDXD7yespsmkD5Ew_MRoz2uGh'
};
