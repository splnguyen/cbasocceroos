// Three-tier flag fallback: local SVG → local PNG → api-football logo CDN.
// API_FALLBACK forces certain teams straight to the api-football logo (their
// SVG flag doesn't render cleanly in a circle — typically complex coats of arms).

const FLAG_MAP = {
  'Algeria':'ALG','Argentina':'ARG','Australia':'AUS','Austria':'AUT','Belgium':'BEL',
  'Bosnia & Herzegovina':'BIH','Brazil':'BRA','Canada':'CAN','Cape Verde':'CPV','Cape Verde Islands':'CPV',
  'Ivory Coast':'CIV','Colombia':'COL','DR Congo':'COD','Congo DR':'COD','Democratic Republic of Congo':'COD','Croatia':'CRO',
  'Curaçao':'CUW','Curacao':'CUW','Ecuador':'ECU','Egypt':'EGY','England':'ENG',
  'Spain':'ESP','France':'FRA','Germany':'GER','Ghana':'GHA','Haiti':'HAI',
  'Iran':'IRN','Iraq':'IRQ','Japan':'JPN','Jordan':'JOR','South Korea':'KOR',
  'Korea Republic':'KOR','Saudi Arabia':'KSA','Morocco':'MAR','Mexico':'MEX',
  'Netherlands':'NED','New Zealand':'NZL','Norway':'NOR','Panama':'PAN',
  'Paraguay':'PAR','Poland':'POL','Portugal':'POR','Qatar':'QAT','Scotland':'SCO',
  'Senegal':'SEN','South Africa':'RSA','Sweden':'SWE','Switzerland':'SUI',
  'Tunisia':'TUN','Türkiye':'TUR','Turkey':'TUR','United States':'USA','USA':'USA',
  'Uruguay':'URU','Uzbekistan':'UZB','Venezuela':'VEN','Serbia':'SRB',
  'Cameroon':'CMR','Czechia':'CZE','Czech Republic':'CZE','Denmark':'DEN','Wales':'WAL','Costa Rica':'CRC',
};

const API_FALLBACK = {
  'POL':'https://media.api-sports.io/football/teams/24.png',
  'SRB':'https://media.api-sports.io/football/teams/14.png',
  'CMR':'https://media.api-sports.io/football/teams/111.png',
  // CZE removed — local SVG/PNG now available
  'DEN':'https://media.api-sports.io/football/teams/21.png',
};

const FLAG_BASE_SVG = 'flags/SVG/';
const FLAG_BASE_PNG = 'flags/PNG/';

function teamCode(name) {
  return FLAG_MAP[name] || (name ? name.slice(0, 3).toUpperCase() : '???');
}

function getFlagSVG(n) {
  const c = FLAG_MAP[n];
  if (!c) return null;
  if (API_FALLBACK[c]) return API_FALLBACK[c];
  return FLAG_BASE_SVG + c + '.svg';
}

function getFlagPNG(n) {
  const c = FLAG_MAP[n];
  if (!c) return null;
  if (API_FALLBACK[c]) return API_FALLBACK[c];
  return FLAG_BASE_PNG + c + '.png';
}

function getFlagAPI(n) {
  const c = FLAG_MAP[n];
  return c && API_FALLBACK[c] ? API_FALLBACK[c] : null;
}

function setFlag(el, name, api) {
  if (!el) return;
  const svg = getFlagSVG(name);
  const png = getFlagPNG(name);
  const a = api || getFlagAPI(name);
  if (svg) {
    el.src = svg;
    el.onerror = function () {
      if (png && png !== svg) {
        el.src = png;
        el.onerror = function () {
          if (a) { el.src = a; el.onerror = null; }
          else { el.style.display = 'none'; }
        };
      } else if (a) {
        el.src = a; el.onerror = null;
      } else {
        el.style.display = 'none';
      }
    };
  } else if (a) {
    el.src = a; el.onerror = null;
  }
}
