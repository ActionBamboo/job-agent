"""核心数据模型（Pydantic）。"""
from typing import Optional

from pydantic import BaseModel, Field


class Experience(BaseModel):
    company: str = ""
    role: str = ""
    period: str = ""
    achievements: list[str] = Field(default_factory=list)


class Education(BaseModel):
    school: str = ""
    degree: str = ""
    major: str = ""
    period: str = ""


class Resume(BaseModel):
    name: str = ""
    title: str = ""
    years_exp: float = 0
    skills: list[str] = Field(default_factory=list)
    experience: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    summary: str = ""
    target_role: str = ""


class Job(BaseModel):
    id: str
    title: str
    company: str
    city: str = ""
    salary: str = ""
    experience_req: str = ""
    education_req: str = ""
    jd_text: str
    url: str = ""
    source: str = "boss"


class MatchDimension(BaseModel):
    name: str
    score: int = Field(ge=0, le=100)
    comment: str = ""


class MatchResult(BaseModel):
    overall_score: int = Field(ge=0, le=100)
    dimensions: list[MatchDimension] = Field(default_factory=list)
    matched_points: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    tailored_message: str = ""
    resume_suggestions: list[str] = Field(default_factory=list)
