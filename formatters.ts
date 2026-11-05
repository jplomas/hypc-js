export function formatFatalError (message) {
  return JSON.stringify({
    errors: [
      {
        type: 'JSONError',
        component: 'hypcjs',
        severity: 'error',
        message,
        formattedMessage: 'Error: ' + message
      }
    ]
  });
}
