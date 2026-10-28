"""
Pydantic AST Data Models for Commonwealth and State Legislation Trees.
"""
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

class ElementNode(BaseModel):
    id: str
    provision_id: str
    element_type: str  # 'subsection', 'paragraph', 'subparagraph', 'definition', 'note', 'penalty', 'continuation', 'heading'
    identifier: Optional[str] = None  # e.g. '(1)', '(a)', '(i)'
    content_text: str
    content_html: str
    order_index: int

class ProvisionNode(BaseModel):
    id: str
    compilation_id: str
    structural_node_id: str
    provision_type: str = "section"  # 'section', 'clause', 'rule'
    identifier: str  # e.g. '18', '51AAA', '45AA'
    title: str  # e.g. 'Misleading or deceptive conduct'
    slug: str  # 's18'
    full_slug: str  # 'schedule-2/s18' or 's18'
    content_html: str
    content_text: str
    order_index: int
    elements: List[ElementNode] = Field(default_factory=list)

class StructuralNode(BaseModel):
    id: str
    compilation_id: str
    parent_node_id: Optional[str] = None
    node_type: str  # 'schedule', 'chapter', 'part', 'division', 'subdivision'
    identifier: str  # 'Schedule 2', 'Part 2-1', 'Division 1'
    title: str  # 'The Australian Consumer Law', 'General protections'
    slug: str  # 'schedule-2/part-2-1'
    path_hierarchy: str  # '/sch-2/pt-2-1'
    order_index: int
    provisions: List[ProvisionNode] = Field(default_factory=list)
    children: List['StructuralNode'] = Field(default_factory=list)

class CompilationAST(BaseModel):
    act_slug: str
    act_title: str
    year: int
    act_number: Optional[int] = None
    compilation_id: str
    compilation_number: str
    register_id: str
    start_date: str
    jurisdiction_id: str = "cth"
    category: str = "act"
    portfolio: str = "commercial"
    root_nodes: List[StructuralNode] = Field(default_factory=list)
    all_provisions: List[ProvisionNode] = Field(default_factory=list)
