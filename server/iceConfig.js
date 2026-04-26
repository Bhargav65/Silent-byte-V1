/**
 * ICE Server configuration.
 * 
 * Serves STUN/TURN credentials via a REST endpoint so the client
 * can fetch them dynamically instead of hardcoding in HTML.
 * 
 * IMPORTANT: For production, you MUST set these environment variables:
 *   TURN_URL        - Your TURN server hostname (e.g. 'relay1.example.com')
 *   TURN_USERNAME   - TURN auth username
 *   TURN_CREDENTIAL - TURN auth credential/password
 * 
 * Without TURN, peers behind symmetric NATs or firewalls cannot connect.
 * Free TURN providers: metered.ca, Twilio NTS, or self-host coturn.
 */

function getIceServers() {
    const turnUrl = process.env.TURN_URL;
    const turnUsername = process.env.TURN_USERNAME;
    const turnCredential = process.env.TURN_CREDENTIAL;

    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
    ];

    if (turnUrl && turnUsername && turnCredential) {
        iceServers.push(
            {
                urls: `turn:${turnUrl}:80`,
                username: turnUsername,
                credential: turnCredential,
            },
            {
                urls: `turn:${turnUrl}:443`,
                username: turnUsername,
                credential: turnCredential,
            },
            {
                urls: `turn:${turnUrl}:443?transport=tcp`,
                username: turnUsername,
                credential: turnCredential,
            }
        );
    } else {
        console.warn('[ICE] WARNING: No TURN server configured. Set TURN_URL, TURN_USERNAME, TURN_CREDENTIAL env vars.');
        console.warn('[ICE] Peers behind NATs/firewalls may not be able to connect without TURN.');
    }

    return {
        iceServers,
        iceCandidatePoolSize: 10,
    };
}

/**
 * Register the ICE config REST endpoint on an Express app.
 */
function registerIceEndpoint(app) {
    app.get('/api/ice-config', (req, res) => {
        res.json(getIceServers());
    });
}

module.exports = { getIceServers, registerIceEndpoint };
