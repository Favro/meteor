function getCookie(name) {
  let regExp = new RegExp(`\\b${name}=([^;]+)`);
  let match = document.cookie.match(regExp);
  return match && match[1];
}

function setCookie(key, value) {
  let cookie = key + "=" + value;
  cookie += "; max-age=63072000";
  cookie += "; path=/";

  let url = Meteor.absoluteUrl();
  if (/^https:/.test(url))
    cookie += "; secure";

  let hostname = url.match(/:\/\/([^\/:]*)/)[1];
  if (hostname != "localhost")
    cookie += "; domain=." + hostname;

  document.cookie = cookie;
}

export function getBrowserId() {
  let browserId = getCookie("xBrowserId");

  if (!browserId) {
    browserId = Random.id();
    setCookie("xBrowserId", browserId);
  }

  return browserId;
}
