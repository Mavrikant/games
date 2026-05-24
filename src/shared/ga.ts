// GA4 (gtag.js) bootstrap with Consent Mode v2 defaults.
//
// Default consent is granted globally (e.g. TR, where no banner is shown) and
// denied in the EEA/UK/CH until Google Funding Choices (a Google-certified CMP
// on the same page) calls gtag('consent','update', …) after the visitor
// answers the GDPR banner. Consent commands are pushed before config so they
// reach the dataLayer ahead of the async library.
//
// Note: Funding Choices must have Consent Mode enabled in the Privacy &
// Messaging console for the 'update' to fire; otherwise EEA stays denied.

const EEA_UK_CH = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
];

export function gtagInitScript(measurementId: string): string {
  const id = JSON.stringify(measurementId);
  const regions = JSON.stringify(EEA_UK_CH);
  return (
    'window.dataLayer=window.dataLayer||[];' +
    'function gtag(){dataLayer.push(arguments);}' +
    "gtag('consent','default',{ad_storage:'granted',ad_user_data:'granted'," +
    "ad_personalization:'granted',analytics_storage:'granted'});" +
    "gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied'," +
    "ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500," +
    'region:' + regions + '});' +
    "gtag('js',new Date());" +
    'gtag(\'config\',' + id + ');'
  );
}
