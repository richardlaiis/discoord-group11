import markdown
import bleach
from django import template
from django.template.defaultfilters import stringfilter
from django.utils.safestring import mark_safe

register = template.Library()

@register.filter
@stringfilter
def render_markdown(value):
    # Convert markdown to HTML
    html = markdown.markdown(value, extensions=['fenced_code', 'tables'])
    
    # Sanitize the HTML using bleach
    allowed_tags = list(bleach.ALLOWED_TAGS) + [
        'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'br', 'pre', 'code', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'blockquote', 'hr', 'img', 'span'
    ]
    allowed_attributes = {
        '*': ['class', 'id', 'title'],
        'a': ['href', 'title', 'target'],
        'img': ['src', 'alt', 'title'],
    }
    
    clean_html = bleach.clean(
        html,
        tags=allowed_tags,
        attributes=allowed_attributes,
        strip=True
    )
    
    return mark_safe(clean_html)
