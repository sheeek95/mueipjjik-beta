// 여러 외부 검색 API(네이버, 유튜브)가 공통으로 돌려주는 HTML 엔티티를 디코드함.
export function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}
