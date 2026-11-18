// Runs before the page draws: marks <html data-os="mac|win|mobile|other"> so the right download
// button and key names show from the first frame. Nothing is stored or sent anywhere.
(function () {
  var nav = navigator, ua = nav.userAgent || '', uad = nav.userAgentData;
  var plat = (uad && uad.platform) || nav.platform || '';
  var touchMac = /Mac/i.test(plat) && nav.maxTouchPoints > 1; // iPadOS reports itself as a Mac
  var os = 'other';
  if ((uad && uad.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || touchMac) os = 'mobile';
  else if (/Win/i.test(plat) || /Windows/i.test(ua)) os = 'win';
  else if (/Mac/i.test(plat) || /Macintosh/i.test(ua)) os = 'mac';
  var root = document.documentElement;
  root.setAttribute('data-os', os);
  var guide = null;
  try { guide = localStorage.getItem('dd-guide-os'); } catch (e) { /* storage blocked */ }
  root.setAttribute('data-guide-os', guide === 'win' || guide === 'mac' ? guide : os === 'win' || (os === 'mobile' && /Android/i.test(ua)) ? 'win' : 'mac');
  root.classList.add('js');
})();
