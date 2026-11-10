"""Build the operations prospectus from reviewed content; no application imports."""
from pathlib import Path
import json
import subprocess
from copy import deepcopy

from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.style import WD_STYLE_TYPE
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'output/operations'
ASSETS = BASE / 'assets'
DATA = json.loads((BASE / 'source/prospectus_content.json').read_text())
OUT = ROOT / 'output/docx/SwasthaDisha_Operations_Prospectus.docx'
TEAL, INK, CORAL, MUTED, MINT, LINE = '146A64', '153D3A', 'B65338', '526561', 'EFF6F3', 'D7E4DF'
RUNTIME = Path('/Users/shubham/.cache/codex-runtimes/codex-primary-runtime/dependencies')
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
pdfmetrics.registerFont(TTFont('Brand', FONT))
pdfmetrics.registerFont(TTFont('BrandBold', BOLD))

TOKENS = {
    'preset': 'compact_reference_guide', 'header_pattern': 'editorial_cover',
    'page_inches': [8.5, 11], 'margins_inches': [1, 1, 1, 1],
    'header_footer_inches': 0.492, 'width_dxa': 9360,
    'body': {'font': 'Arial', 'size_pt': 11, 'before_pt': 0, 'after_pt': 6, 'line': 1.25},
    'headings': {'h1': [16,18,10], 'h2': [13,14,7], 'h3': [12,10,5]},
    'lists': {'left_dxa': 540, 'hanging_dxa': 270, 'after_pt':4, 'line':1.25},
    'table': {'width_dxa':9360,'indent_dxa':120,'cell_margins_dxa':[80,80,120,120]},
    'named_overrides': {
        'BrandTypography': 'Arial throughout; teal headings, coral kicker, dark green body.',
        'EditorialPageTitle': 'Separate named paragraph style, 25 pt, line 1.06, 0/10 pt spacing.',
        'CoverWordmark': '32 pt bold with 12 pt tagline; a typographic treatment, not a selected logo.',
        'CoverHeadline': '28 pt bold, line 1.08, 0/10 pt spacing.',
        'BrandTable': '10.5 pt body, 1.12 line; 10 pt white header on teal; exact DXA geometry.',
        'CaptionAndNote': '9.5 pt, 1.12 line, muted; 8/0 pt spacing.',
        'OperatingCallout': '10.5 pt, 1.15 line, 8/8 pt spacing; pale mint shading and 6 pt inset/border spacing.',
        'SourceList': '9 pt, 1.1 line, 0/3 pt spacing.',
        'FigureParagraph': '0/8 pt spacing, single line; image aspect preserved, no crop.',
    },
}
(BASE / 'source/design_tokens.json').write_text(json.dumps(TOKENS,indent=2)+'\n')

def text(c, x, y, s, size=11, color=INK, bold=False, align='left'):
    c.setFillColor(HexColor('#'+color)); c.setFont('BrandBold' if bold else 'Brand',size)
    fn = c.drawCentredString if align=='center' else c.drawString
    fn(x,y,s)

def rect(c,x,y,w,h,fill=MINT,stroke=None,r=7):
    c.setFillColor(HexColor('#'+fill))
    c.setStrokeColor(HexColor('#'+(stroke or fill)))
    c.roundRect(x,y,w,h,r,stroke=bool(stroke),fill=True)

def make_diagram(name):
    w,h = (468,168) if name=='ecosystem' else (468,128)
    path=ASSETS/(name+'.pdf');c=canvas.Canvas(str(path),pagesize=(w,h))
    c.setTitle('SwasthaDisha planned service diagram')
    c.setFillColor(HexColor('#FFFFFF'));c.rect(0,0,w,h,fill=1,stroke=0)
    if name=='ecosystem':
        rect(c,60,125,348,35,TEAL)
        text(c,234,138,'App  /  Assisted counter  /  Planned phone access',10.5,'FFFFFF',True,'center')
        c.setStrokeColor(HexColor('#A7C6BE'));c.setLineWidth(1.2)
        c.line(234,125,234,110);c.line(55,110,413,110)
        labels=[('Pharmacies','Medicines & sales'),('Doctors / clinics','Visits & follow-up'),('Laboratories','Tests & reports'),('Hospitals','OPD & departments')]
        for i,(a,b) in enumerate(labels):
            x=i*120
            c.line(x+54,110,x+54,98)
            rect(c,x,49,108,49,MINT)
            text(c,x+54,79,a,10.5,TEAL,True,'center')
            text(c,x+54,62,b,9.2,MUTED,False,'center')
        rect(c,0,0,468,34,'F7F4ED')
        text(c,234,13,'Private workspaces  |  Staff  |  Billing  |  Stock  |  Authorized records',10,INK,False,'center')
    else:
        for x,a,b in [(0,'API-connected third-party lab','Orders and updates through an integration'),(240,'Panel-managed third-party lab','Staff enter orders, samples and reports')]:
            rect(c,x,63,228,58,MINT)
            text(c,x+114,98,a,10.5,TEAL,True,'center')
            text(c,x+114,79,b,9.1,MUTED,False,'center')
        c.setStrokeColor(HexColor('#A7C6BE'));c.setLineWidth(1.2)
        c.line(114,63,114,49);c.line(354,63,354,49);c.line(114,49,354,49);c.line(234,49,234,37)
        rect(c,0,0,468,37,TEAL)
        text(c,234,22,'Shared worklists, verified report versions and release events',10.3,'FFFFFF',True,'center')
        text(c,234,8,'Direct and app orders  |  Billing  |  Consumables  |  Scoped access',9.2,'FFFFFF',False,'center')
    c.save()
    subprocess.run([str(RUNTIME/'bin/override/pdftoppm'),'-png','-singlefile','-scale-to','1800',str(path),str(ASSETS/name)],check=True,capture_output=True)

for name in ['ecosystem','lab_routes']:make_diagram(name)

doc=Document();sec=doc.sections[0]
sec.page_width=Inches(8.5);sec.page_height=Inches(11)
sec.top_margin=sec.bottom_margin=sec.left_margin=sec.right_margin=Inches(1)
sec.header_distance=sec.footer_distance=Inches(.492)
sec.different_first_page_header_footer=True

def style(name,size=11,color=INK,bold=False,before=0,after=6,line=1.25):
    s=doc.styles[name] if name in doc.styles else doc.styles.add_style(name,WD_STYLE_TYPE.PARAGRAPH)
    s.font.name='Arial';s.font.size=Pt(size);s.font.bold=bold;s.font.italic=False;s.font.color.rgb=RGBColor.from_string(color)
    s.element.get_or_add_rPr().rFonts.set(qn('w:ascii'),'Arial')
    s.element.get_or_add_rPr().rFonts.set(qn('w:hAnsi'),'Arial')
    p=s.paragraph_format;p.space_before=Pt(before);p.space_after=Pt(after);p.line_spacing=line
    p.left_indent=p.right_indent=p.first_line_indent=Pt(0)
    for child in list(s.element.get_or_add_pPr()):
        if child.tag in [qn('w:pBdr'),qn('w:numPr')]:s.element.get_or_add_pPr().remove(child)
    p.widow_control=True
    return s

style('Normal')
style('Title',32,TEAL,True,0,3,1.0)
style('Subtitle',12,MUTED,False,0,18,1.1)
for n,size,before,after in [('Heading 1',16,18,10),('Heading 2',13,14,7),('Heading 3',12,10,5)]:
    s=style(n,size,TEAL,True,before,after,1.25);s.paragraph_format.keep_with_next=True
style('PageTitle',25,INK,True,0,10,1.06).paragraph_format.keep_with_next=True
style('CoverHeadline',28,INK,True,0,10,1.08).paragraph_format.keep_with_next=True
style('Kicker',9.5,CORAL,True,0,8,1.1).paragraph_format.keep_with_next=True
style('Intro',11.5,MUTED,False,0,9,1.2)
style('Note',9.5,MUTED,False,8,0,1.12)
style('OperatingCallout',10.5,TEAL,False,8,8,1.15)
style('FigureParagraph',11,INK,False,0,8,1.0)
style('SourceList',9,MUTED,False,0,3,1.1)
style('TableBody',10.5,INK,False,0,0,1.12)
style('TableHeader',10,'FFFFFF',True,0,0,1.12)
style('TableCitation',9.5,MUTED,False,4,4,1.12)
style('PageFurniture',8.5,MUTED,False,0,0,1)
style('ProspectusBullet',11,INK,False,0,4,1.25)

numbering=doc.part.numbering_part.element
abstract=OxmlElement('w:abstractNum');abstract.set(qn('w:abstractNumId'),'50')
multi=OxmlElement('w:multiLevelType');multi.set(qn('w:val'),'singleLevel');abstract.append(multi)
lvl=OxmlElement('w:lvl');lvl.set(qn('w:ilvl'),'0')
for name,val in [('start','1'),('numFmt','bullet'),('lvlText','•'),('lvlJc','left')]:
    x=OxmlElement('w:'+name);x.set(qn('w:val'),val);lvl.append(x)
pp=OxmlElement('w:pPr');tabs=OxmlElement('w:tabs');tab=OxmlElement('w:tab');tab.set(qn('w:val'),'num');tab.set(qn('w:pos'),'540');tabs.append(tab);pp.append(tabs)
ind=OxmlElement('w:ind');ind.set(qn('w:left'),'540');ind.set(qn('w:hanging'),'270');pp.append(ind);lvl.append(pp)
rp=OxmlElement('w:rPr');rf=OxmlElement('w:rFonts');rf.set(qn('w:ascii'),'Arial');rf.set(qn('w:hAnsi'),'Arial');rp.append(rf);lvl.append(rp)
abstract.append(lvl);numbering.append(abstract)
num=OxmlElement('w:num');num.set(qn('w:numId'),'50');aid=OxmlElement('w:abstractNumId');aid.set(qn('w:val'),'50');num.append(aid);numbering.append(num)

def para(t,s='Normal',align=None):
    p=doc.add_paragraph(t,s)
    if align is not None:p.alignment=align
    return p

def bullet(t):
    p=para(t,'ProspectusBullet');pp=p._p.get_or_add_pPr();np=OxmlElement('w:numPr')
    lvl=OxmlElement('w:ilvl');lvl.set(qn('w:val'),'0');ni=OxmlElement('w:numId');ni.set(qn('w:val'),'50');np.extend([lvl,ni]);pp.append(np)
    p.paragraph_format.keep_together=True

def field(p,code):
    r=p.add_run();x=OxmlElement('w:fldSimple');x.set(qn('w:instr'),code)
    rr=OxmlElement('w:r');tt=OxmlElement('w:t');tt.text='1';rr.append(tt);x.append(rr);r._r.addnext(x)

hp=sec.header.paragraphs[0];hp.style=doc.styles['PageFurniture']
hp.text='SWASTHADISHA  /  OPERATIONS & SERVICES'
fp=sec.footer.paragraphs[0];fp.style=doc.styles['PageFurniture']
fp.paragraph_format.tab_stops.add_tab_stop(Inches(6.5),WD_TAB_ALIGNMENT.RIGHT)
fp.add_run('PRE-LAUNCH  |  PLANNED SCOPE\t');field(fp,'PAGE')
ff=sec.first_page_footer.paragraphs[0];ff.style=doc.styles['PageFurniture'];ff.text='INTERNAL OPERATIONS PROSPECTUS  |  9 NOVEMBER 2026'

def image(name,width=6.5,maxheight=None):
    path=ASSETS/(name+'.png');im=Image.open(path)
    if maxheight:width=min(width,maxheight*im.width/im.height)
    p=para('','FigureParagraph');p.alignment=WD_ALIGN_PARAGRAPH.LEFT if width>=6.49 else WD_ALIGN_PARAGRAPH.CENTER
    shape=p.add_run().add_picture(str(path),width=Inches(width))
    shape._inline.docPr.set('descr',{
      'community':'Concept illustration of a family, pharmacy, doctor, laboratory and hospital in a welcoming Indian town.',
      'counter':'Concept illustration of direct healthcare counter service, a printed receipt and inventory work.',
      'phone':'Concept illustration of an older patient using a keypad phone to speak with a doctor.',
      'ecosystem':'Planned channels connect pharmacies, doctors, laboratories and hospitals through shared private operations.',
      'lab_routes':'API-connected labs and panel-managed labs share order, report release, billing and consumables rules.'
    }[name])

def table(data):
    headers,rows,widths=data['headers'],data['rows'],data['widths']
    assert sum(widths)==9360
    t=doc.add_table(rows=1,cols=len(headers));t.autofit=False
    pr=t._tbl.tblPr
    for tag in ['tblW','tblInd','tblLayout','tblBorders','tblCellMar']:
        el=pr.find(qn('w:'+tag))
        if el is not None:pr.remove(el)
    for tag,val in [('tblW','9360'),('tblInd','120')]:
        el=OxmlElement('w:'+tag);el.set(qn('w:w'),val);el.set(qn('w:type'),'dxa');pr.append(el)
    layout=OxmlElement('w:tblLayout');layout.set(qn('w:type'),'fixed');pr.append(layout)
    margins=OxmlElement('w:tblCellMar')
    for name,value in [('top',80),('bottom',80),('start',120),('end',120)]:
        e=OxmlElement('w:'+name);e.set(qn('w:w'),str(value));e.set(qn('w:type'),'dxa');margins.append(e)
    pr.append(margins)
    borders=OxmlElement('w:tblBorders')
    for name in ['top','left','bottom','right','insideH','insideV']:
        e=OxmlElement('w:'+name);e.set(qn('w:val'),'single');e.set(qn('w:sz'),'4');e.set(qn('w:color'),LINE);borders.append(e)
    pr.append(borders)
    grid=t._tbl.tblGrid
    for e in list(grid):grid.remove(e)
    for w in widths:
        e=OxmlElement('w:gridCol');e.set(qn('w:w'),str(w));grid.append(e)
    for i,rowdata in enumerate([headers]+rows):
        row=t.rows[0] if i==0 else t.add_row()
        trpr=row._tr.get_or_add_trPr();no=OxmlElement('w:cantSplit');trpr.append(no)
        if i==0:trpr.append(OxmlElement('w:tblHeader'))
        for cell,txt,w in zip(row.cells,rowdata,widths):
            cell.width=Inches(w/1440)
            tcw=cell._tc.get_or_add_tcPr().find(qn('w:tcW'));tcw.set(qn('w:w'),str(w));tcw.set(qn('w:type'),'dxa')
            p=cell.paragraphs[0];p.style=doc.styles['TableHeader' if i==0 else 'TableBody'];p.text=txt
            if i==0:
                sh=OxmlElement('w:shd');sh.set(qn('w:fill'),TEAL);cell._tc.get_or_add_tcPr().append(sh)
    para('','TableCitation')

for idx,page in enumerate(DATA['pages']):
    if page.get('kind')=='cover':
        para(DATA['brand'],'Title');para(DATA['tagline'],'Subtitle')
        para(DATA['title'].upper(),'Kicker');para(page['title'],'CoverHeadline')
        para(page['intro'],'Intro');image(page['image'],width=6.5)
        para(page['closing'],'Normal');para(page['note'],'Note')
        continue
    k=para(page['kicker'],'Kicker');k.paragraph_format.page_break_before=bool(idx)
    para(page['title'],'PageTitle');para(page['intro'],'Intro')
    if page.get('diagram'):image(page['diagram'])
    if page.get('image'):image(page['image'],maxheight=page.get('image_height'))
    if page.get('table'):table(page['table'])
    for part in page.get('sections',[]):
        para(part['title'],'Heading 2')
        if 'text' in part:para(part['text'])
        for item in part.get('bullets',[]):bullet(item)
    if page.get('callout'):
        p=para(page['callout'],'OperatingCallout')
        sh=OxmlElement('w:shd');sh.set(qn('w:fill'),MINT);p._p.get_or_add_pPr().append(sh)
        p.paragraph_format.left_indent=p.paragraph_format.right_indent=Pt(6)
        borders=OxmlElement('w:pBdr')
        for name in ['top','left','bottom','right']:
            e=OxmlElement('w:'+name);e.set(qn('w:val'),'single');e.set(qn('w:sz'),'6');e.set(qn('w:space'),'6');e.set(qn('w:color'),MINT);borders.append(e)
        p._p.get_or_add_pPr().append(borders)
    if page.get('sources'):
        para('Planning sources in documentation/planning/','Heading 3')
        for s in page['sources']:para(s,'SourceList')
    if page.get('note'):para(page['note'],'Note')

doc.core_properties.title='SwasthaDisha | Operations & Services Prospectus'
doc.core_properties.subject='Planned product features and operational scope, pre-launch'
doc.core_properties.author='SwasthaDisha'
doc.core_properties.keywords='operations, pharmacy, doctors, laboratories, hospitals, vendors, planned scope'
doc.core_properties.comments='Planning baseline v1.7. AI-generated conceptual illustrations. No application checks executed.'
doc.save(OUT)

# Editable plain-text companion and source audit are generated from the same content.
lines=['# '+DATA['brand']+' - '+DATA['title'], '', DATA['tagline'], '', '**Pre-launch | '+DATA['date']+' | Prospectus v'+DATA['version']+'**', '']
for idx,page in enumerate(DATA['pages'],1):
    lines += ['## '+str(idx)+'. '+page['title'].replace('\n',' '),'',page['intro'],'']
    if page.get('image'):lines += [f"![Concept illustration](../../output/operations/assets/{page['image']}.png)",'']
    if page.get('diagram'):lines += [f"![Planned workflow](../../output/operations/assets/{page['diagram']}.png)",'']
    if page.get('closing'):lines += [page['closing'],'']
    if page.get('table'):
        tb=page['table'];lines += ['| '+' | '.join(tb['headers'])+' |','| '+' | '.join(['---']*len(tb['headers']))+' |']
        lines += ['| '+' | '.join(row)+' |' for row in tb['rows']];lines.append('')
    for part in page.get('sections',[]):
        lines += ['### '+part['title'],'']
        if 'text' in part:lines += [part['text'],'']
        if part.get('bullets'):lines += ['- '+v for v in part['bullets']]+['']
    if page.get('callout'):lines += ['> '+page['callout'],'']
    if page.get('sources'):lines += ['### Planning sources','']+['- `documentation/planning/'+s+'`' for s in page['sources']]+['']
    if page.get('note'):lines += ['*'+page['note']+'*','']
(ROOT/'documentation/operations/SWASTHADISHA_PROSPECTUS.md').write_text('\n'.join(lines)+'\n')

# Geometry/style assertions are structural QA; application tests are not involved.
assert sec.page_width==Inches(8.5) and sec.page_height==Inches(11)
assert all(x==Inches(1) for x in [sec.top_margin,sec.bottom_margin,sec.left_margin,sec.right_margin])
assert doc.styles['Normal'].font.size==Pt(11)
for t in doc.tables:
    assert t._tbl.tblPr.find(qn('w:tblW')).get(qn('w:w'))=='9360'
    assert t._tbl.tblPr.find(qn('w:tblInd')).get(qn('w:w'))=='120'
    widths=[int(e.get(qn('w:w'))) for e in t._tbl.tblGrid]
    assert sum(widths)==9360
    for row in t.rows:
        assert [int(c._tc.get_or_add_tcPr().find(qn('w:tcW')).get(qn('w:w'))) for c in row.cells]==widths
print(json.dumps({'docx':str(OUT),'planned_pages':len(DATA['pages']),'words':len(' '.join(lines).split()),'tables':len(doc.tables),'images':len(doc.inline_shapes),'structural_checks':'passed'},indent=2))
