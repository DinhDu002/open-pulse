// Projects — top-level module wrapping learning-projects
import { renderList, renderDetail, destroyCharts } from './learning-projects.js';

export function mount(el, { params }) {
  var detail = params ? params.split('/')[0] : null;
  if (detail) {
    renderDetail(el, decodeURIComponent(detail));
  } else {
    renderList(el);
  }
}

export function unmount() {
  destroyCharts();
}
